import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { NotionBackend, notionConfig } from "../dist/plugin/notion.js"
import { NotionTransport, SESSION_HEADER, MESSAGE_HEADER } from "../dist/plugin/transport.js"
import { Journal } from "../dist/plugin/storage.js"
import { InferenceText, inferenceStream } from "../dist/vendor/notion-ai/inference-stream.js"
import { createAgentTranscriptState, applyAgentTranscriptPatches, agentTranscriptVisibleText } from "../dist/vendor/notion-ai/agent-transcript.js"
import { OpenCodeDisplay } from "../dist/plugin/live.js"
import { secretRedactor, displayValue } from "../dist/plugin/redact.js"
const enc = new TextEncoder()
async function eventually(check, message) {
  for (let i=0;i<200;i++) { if (check()) return; await delay(10) }
  assert.fail(message)
}
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "notion-live-")); t.after(()=>rm(dir,{recursive:true,force:true}))
  const journal = new Journal(join(dir,"turns.json")); await journal.load()
  return { dir, journal }
}
function config(dir) {
  const c = notionConfig({model:"default",tokenV2:"COOKIE_SECRET",account:{}},dir)
  c.account={tokenV2:"COOKIE_SECRET",userId:randomUUID(),userName:"Fixture",userEmail:"fixture@example.com",spaceId:randomUUID(),spaceName:"Fixture",spaceViewId:randomUUID(),timezone:"UTC"}
  return c
}
const inference = text => ({type:"agent-inference",id:"answer",value:[{type:"thinking",content:"HIDDEN_THINKING"},{type:"text",content:text}]})
const line = value => enc.encode(JSON.stringify(value)+"\n")
function request(transport, {session="ses_live",message="msg_user",stream=true,prompt="hello"}={}) {
  return transport.fetch("https://opencode-notion.invalid/v1/chat/completions", {method:"POST",headers:{[SESSION_HEADER]:session,[MESSAGE_HEADER]:message},
    body:JSON.stringify({model:"chat",stream,messages:[{role:"user",content:prompt}]})})
}
async function collect(response, chunks) {
  const reader=response.body.getReader(), decoder=new TextDecoder();let all=""
  for (;;) { const {done,value}=await reader.read();if(done)break;const s=decoder.decode(value,{stream:true});chunks.push(s);all+=s }
  return all+decoder.decode()
}
function text(chunks) { return chunks.join("").split("\n").filter(x=>x.startsWith("data: {")).map(x=>JSON.parse(x.slice(6))).map(x=>x.choices?.[0]?.delta?.content ?? "").join("") }

test("real Notion NDJSON streams visible text before completion; snapshots, patches and UTF-8 do not duplicate", async t=>{
  const f=await fixture(t);let upstream, completed=false
  const backend=new NotionBackend(config(f.dir),async()=>new Response(new ReadableStream({start(c){upstream=c}})))
  const transport=new NotionTransport(backend,f.journal,"context");t.after(()=>transport.close())
  const chunks=[], collecting=collect(await request(transport),chunks)
  await eventually(()=>upstream,"Notion was not dispatched")
  const bytes=line(inference("調査")); const split=bytes.findIndex((b,i)=>b>=0xe0&&i>25)+1
  upstream.enqueue(bytes.slice(0,split));upstream.enqueue(bytes.slice(split))
  await eventually(()=>text(chunks)==="調査","public text did not arrive live")
  assert.equal(completed,false);upstream.enqueue(line(inference("調査")))
  upstream.enqueue(line({type:"patch",v:[{o:"x",p:"/s/answer/value/0/content",v:"DO_NOT_LEAK"},{o:"x",p:"/s/answer/value/1/content",v:"中"}]}))
  await eventually(()=>text(chunks)==="調査中","delta was not appended")
  upstream.enqueue(line(inference("調査中")))
  upstream.enqueue(line({type:"agent-inference",id:"final",value:[{type:"text",content:"完了"}]}));upstream.close();completed=true
  const result=await collecting
  assert.equal(text(chunks),"調査中\n\n完了");assert.doesNotMatch(result,/HIDDEN|DO_NOT_LEAK|tool_calls/)
  assert.equal(f.journal.data.sessions.ses_live.turns.msg_user.text,"調査中\n\n完了")
})

test("strict public-text allowlist drops unknown, nested tool and reasoning patch content",()=>{
  const seen=[], p=new InferenceText(s=>seen.push(s))
  for(const event of [
    {type:"patch",v:[{o:"x",p:"/s/a/value/0/content",v:"UNKNOWN_HIDDEN"},{o:"x",p:"/s/a/value/0/content/nested",v:"NESTED_HIDDEN"}]},
    {type:"patch",v:[{o:"a",p:"/s/a/value/-",v:{type:"tool_use",content:"TOOL_HIDDEN"}},{o:"x",p:"/s/a/value/0/content",v:"MORE_HIDDEN"},{o:"a",p:"/s/a/value/-",v:{type:"text",content:"Hi"}}]},
    {type:"patch",v:[{o:"x",p:"/s/a/value/1/content",v:"<la"}]},
    {type:"patch",v:[{o:"x",p:"/s/a/value/1/content",v:"ng value=\"en\"/>!"}]},
    {type:"agent-inference",id:"a",value:[{type:"tool_use",content:"TOOL_HIDDEN"},{type:"text",content:"Hi!"}]},
  ])p.line(JSON.stringify(event))
  assert.equal(p.result().text,"Hi!");assert.deepEqual(seen,["Hi","Hi!"])
  assert.throws(()=>p.line(JSON.stringify({type:"error",message:"fail"})),/fail/)
})

test("NDJSON parser releases the reader and cancels on upstream errors",async()=>{
  let cancelled=false
  const stream=new ReadableStream({start(c){c.enqueue(line({type:"error",message:"upstream failed"}))},cancel(){cancelled=true}})
  await assert.rejects(inferenceStream(stream),/upstream failed/);assert.equal(cancelled,true);assert.equal(stream.locked,false)
})

test("streaming redactor holds credential prefixes across arbitrary event boundaries",async t=>{
  const f=await fixture(t), secrets=["COOKIE_SECRET","MCP_BEARER_SECRET"], redact=secretRedactor(()=>secrets)
  let finish;const gate=new Promise(r=>finish=r), chunks=[]
  const backend={send:async input=>{input.onText("visible COOKIE_");await gate;input.onText("visible COOKIE_SECRET + MCP_BEARER_");input.onText("visible COOKIE_SECRET + MCP_BEARER_SECRET done");return "visible COOKIE_SECRET + MCP_BEARER_SECRET done"},interrupt:async()=>{}}
  const transport=new NotionTransport(backend,f.journal,"context",redact);t.after(()=>transport.close());t.after(()=>finish())
  const pending=collect(await request(transport),chunks)
  await eventually(()=>text(chunks)==="visible ","safe prefix was not emitted")
  assert.doesNotMatch(chunks.join(""),/COOKIE_/);finish();await pending
  assert.equal(text(chunks),"visible [redacted] + [redacted] done")
  const saved=await readFile(join(f.dir,"turns.json"),"utf8");assert.doesNotMatch(saved,/COOKIE_SECRET|MCP_BEARER_SECRET/)
  const input={command:"echo COOKIE_SECRET",authorization:"Bearer another-secret",nested:{api_key:"other",reasoning:"HIDDEN"}}
  const output=displayValue(input,redact)
  assert.equal(input.authorization,"Bearer another-secret");assert.doesNotMatch(JSON.stringify(output),/COOKIE_SECRET|another-secret|HIDDEN|"other"/)
})

test("final-only upstream stays final-only instead of fabricating progress",async t=>{
  const f=await fixture(t);let finish,started=false;const gate=new Promise(r=>finish=r)
  const transport=new NotionTransport({send:async()=>{started=true;await gate;return "one final"},interrupt:async()=>{}},f.journal,"context")
  t.after(()=>transport.close());t.after(()=>finish())
  const chunks=[],pending=collect(await request(transport),chunks);await eventually(()=>started,"not started");assert.equal(text(chunks),"")
  finish();await pending;assert.equal(text(chunks),"one final")
})

test("concurrent duplicate stream joins one turn and receives its current snapshot; another turn stays locked",async t=>{
  const f=await fixture(t);let finish,calls=0;const gate=new Promise(r=>finish=r)
  const transport=new NotionTransport({send:async input=>{calls++;input.onText("before ");await gate;return "before after"},interrupt:async()=>{}},f.journal,"context")
  t.after(()=>transport.close());t.after(()=>finish())
  const first=[],a=collect(await request(transport),first);await eventually(()=>text(first)==="before ","no progress")
  const second=[],b=collect(await request(transport),second);await eventually(()=>text(second)==="before ","late subscriber missed snapshot")
  const blocked=await request(transport,{session:"ses_other",stream:false});assert.match(await blocked.text(),/Another Notion turn/)
  finish();await Promise.all([a,b]);assert.equal(calls,1);assert.equal(text(first),"before after");assert.equal(text(second),text(first))
  const replay=await request(transport,{stream:false});assert.equal((await replay.json()).choices[0].message.content,"before after");assert.equal(calls,1)
})

test("cancel after streamed text interrupts Notion/tools and leaves no-replay state",async t=>{
  const f=await fixture(t);let started=false,interrupts=0,cancels=0,calls=0
  const backend={send:async input=>{calls++;started=true;input.onText("in progress");await new Promise((_,reject)=>input.signal.addEventListener("abort",()=>reject(input.signal.reason),{once:true}));return "never"},interrupt:async()=>{interrupts++}}
  const transport=new NotionTransport(backend,f.journal,"context",text=>text,async()=>{cancels++});t.after(()=>transport.close())
  const response=await request(transport),reader=response.body.getReader();await reader.read();await eventually(()=>started,"not started");await reader.cancel();await transport.close()
  assert.equal(f.journal.data.sessions.ses_live.turns.msg_user.status,"interrupted");assert.equal(interrupts,1);assert.equal(cancels,1)
  const fresh=new NotionTransport(backend,f.journal,"context");const retry=await request(fresh,{stream:false});assert.match(await retry.text(),/already dispatched/);assert.equal(calls,1)
})

test("failure after partial text is redacted and never silently replayed",async t=>{
  const f=await fixture(t);let calls=0
  const transport=new NotionTransport({send:async input=>{calls++;input.onText("some text");throw Error("COOKIE_SECRET failure")},interrupt:async()=>{}},f.journal,"context",secretRedactor(()=>["COOKIE_SECRET"]))
  const chunks=[];await collect(await request(transport),chunks);assert.equal(text(chunks),"some text");assert.match(chunks.join(""),/\[redacted\] failure/);assert.doesNotMatch(chunks.join(""),/COOKIE_SECRET/)
  assert.equal(f.journal.data.sessions.ses_live.turns.msg_user.status,"uncertain")
  assert.match(await (await request(transport,{stream:false})).text(),/already dispatched/);assert.equal(calls,1)
})

function displayFixture() {
  const messages=[{id:"msg_u",sessionID:"ses_s",role:"user"},{id:"msg_a",parentID:"msg_u",sessionID:"ses_s",role:"assistant",providerID:"notion-ai",modelID:"chat",agent:"notion",time:{},path:{cwd:"/workspace"}},
    {id:"msg_other",parentID:"msg_other_user",sessionID:"ses_s",role:"assistant",providerID:"other",time:{}}]
  const writes=[], client={session:{message:async({path})=>({data:{info:messages.find(x=>x.id===path.messageID)}}),messages:async()=>({data:messages.map(info=>({info}))})}},raw={patch:async req=>{writes.push(structuredClone(req));return {data:req.body}}}
  client._client=raw
  return {messages,writes,client,display:new OpenCodeDisplay({client,directory:"/workspace"},secretRedactor(()=>["COOKIE_SECRET","MCP_SECRET"]))}
}
function execution(type,status,id="job_one",input={command:"echo COOKIE_SECRET",password:"do-not-show"}) {
  return {type,input,job:{job_id:id,tool:"bash",status,created_at:new Date().toISOString(),updated_at:new Date().toISOString(),
    ...(status==="completed"?{result:{title:"Done",output:"MCP_SECRET result",metadata:{}}}:{}),...(status==="failed"?{error:"COOKIE_SECRET failed"}:{})}}
}
test("SDK display-only cards use verified assistant identity, safe arguments/results and actual states",async()=>{
  const f=displayFixture(), turn=await f.display.begin("ses_s","msg_u")
  turn.update(execution("start","running"));await turn.flush();turn.update(execution("update","completed"));await turn.flush()
  assert.deepEqual(f.writes.map(x=>x.body.state.status),["running","completed"])
  assert.equal(f.writes[0].body.id,f.writes[1].body.id);assert.equal(f.writes[0].body.messageID,"msg_a");assert.equal(f.writes[0].body.sessionID,"ses_s")
  assert.equal(f.writes[1].body.tool,"opencode_mcp.bash");assert.equal(f.writes[1].body.state.output,"[redacted] result")
  assert.equal(f.writes[0].body.metadata.notionDisplay.displayOnly,true);assert.doesNotMatch(JSON.stringify(f.writes),/COOKIE_SECRET|MCP_SECRET|do-not-show/)
  assert.ok(f.writes.every(x=>x.url==="/session/{sessionID}/message/{messageID}/part/{partID}"));await f.display.close()
})

test("display rejects user/foreign/ambiguous targets and changed assistant identity",async()=>{
  const f=displayFixture();await assert.rejects(f.display.begin("ses_s","msg_other"),/non-user/)
  f.messages.push({...f.messages[1],id:"msg_a2"});await assert.rejects(f.display.begin("ses_s","msg_u"),/uniquely/);f.messages.pop()
  const turn=await f.display.begin("ses_s","msg_u");f.messages[1].role="user";turn.update(execution("start","running"));await assert.rejects(turn.flush(),/identity changed/);assert.equal(f.writes.length,0)
})

test("final text reconciliation only changes the exact completed assistant part",async()=>{
  const f=displayFixture(),turn=await f.display.begin("ses_s","msg_u");turn.finalText("corrected COOKIE_SECRET")
  const wrong={text:"untouched"};f.display.complete({sessionID:"other",messageID:"msg_a"},wrong);assert.equal(wrong.text,"untouched")
  const user={text:"user"};f.display.complete({sessionID:"ses_s",messageID:"msg_u"},user);assert.equal(user.text,"user")
  const output={text:"old prefix"};f.display.complete({sessionID:"ses_s",messageID:"msg_a"},output);assert.equal(output.text,"corrected [redacted]")
})

test("Agent Service aggregate includes only assistant messages, not thinking/tool entities",()=>{
  const state=createAgentTranscriptState()
  applyAgentTranscriptPatches(state,[{op:"put",entity:{id:"a",kind:"assistant_message",sequence:1,content:[{type:"text",text:"checking"}]}},
    {op:"put",entity:{id:"b",kind:"thinking",sequence:2,content:[{type:"text",text:"HIDDEN"}]}},
    {op:"put",entity:{id:"c",kind:"assistant_message",sequence:3,content:[{type:"tool_use",text:"HIDDEN_TOOL"},{type:"text",text:"done"}]}}])
  assert.equal(agentTranscriptVisibleText(state),"checking\n\ndone")
})

test("explicit per-turn model reaches Notion and a different model does not inherit old reasoning effort",async t=>{
  const f=await fixture(t), requests=[],c=config(f.dir),backend=new NotionBackend(c,async(_url,init)=>{requests.push(JSON.parse(init.body));return new Response(line(inference("answer")))})
  const id=randomUUID(),base={conversationId:id,signal:new AbortController().signal,prompt:"hello"}
  await backend.send({...base,fresh:true,model:"oatmeal-cookie",reasoningEffort:"high"})
  await backend.send({...base,fresh:false,model:"oatmeal-cookie"})
  await backend.send({...base,fresh:false,model:"openai-gpt-4o"})
  const configs=requests.map(body=>body.transcript.filter(x=>x.type==="config").at(-1).value)
  assert.equal(configs[0].model,"oatmeal-cookie");assert.equal(configs[0].reasoningEffort,"high")
  assert.equal(configs[1].reasoningEffort,"high");assert.equal(configs[2].model,"openai-gpt-4o");assert.equal(configs[2].reasoningEffort,undefined)
})

test("snapshot and patch token usage is per-step, repeated snapshots do not double count",()=>{
  const p=new InferenceText()
  const full={...inference("answer"),inputTokens:10,outputTokens:3}
  p.line(JSON.stringify(full));p.line(JSON.stringify(full))
  p.line(JSON.stringify({type:"patch",v:[{o:"a",p:"/s/answer/inputTokens",v:10},{o:"a",p:"/s/answer/outputTokens",v:4},
    {o:"a",p:"/s/next",v:{type:"agent-inference",value:[{type:"text",content:"next"}],inputTokens:2,outputTokens:1}}]}))
  const result=p.result();assert.equal(result.inputTokens,12);assert.equal(result.outputTokens,5);assert.equal(result.text,"answer\n\nnext")
  assert.throws(()=>p.line(JSON.stringify({type:"premium-feature-unavailable",featureAvailability:{limit:{current:10,total:10}}})),/credit limit reached: 10\/10/)
})

test("SSE framing, CRLF, unterminated last frame and explicit text removals are handled",async()=>{
  const p=new InferenceText()
  p.line(JSON.stringify(inference("old")));p.line(JSON.stringify({type:"patch",v:[{o:"r",p:"/s/answer/value/1/content"}]}));assert.equal(p.result().text,"")
  const stream=new ReadableStream({start(c){c.enqueue(enc.encode('event: chunk\r\n: heartbeat\r\ndata: '+JSON.stringify(inference("new"))+'\r\ndata: [DONE]'));c.close()}})
  assert.equal((await inferenceStream(stream)).text,"new");assert.equal(stream.locked,false)
})

test("non-prefix revision is reconciled once without appending a duplicate whole response",async t=>{
  const f=await fixture(t), host=displayFixture()
  const transport=new NotionTransport({send:async input=>{input.onText("old draft");input.onText("corrected");return "corrected"},interrupt:async()=>{}},f.journal,"context")
  transport.display=host.display;const chunks=[]
  await collect(await request(transport,{session:"ses_s",message:"msg_u"}),chunks)
  assert.equal(text(chunks),"old draft");assert.doesNotMatch(chunks.join(""),/"error"/)
  const final={text:text(chunks)};host.display.complete({sessionID:"ses_s",messageID:"msg_a"},final);assert.equal(final.text,"corrected")
})

test("rapid native progress is coalesced while preserving the first running and terminal cards",async()=>{
  const f=displayFixture();let release,started=false;const gate=new Promise(r=>release=r)
  f.client._client.patch=async req=>{f.writes.push({body:structuredClone(req.body)});if(!started){started=true;await gate}return {}}
  const turn=await f.display.begin("ses_s","msg_u");turn.update(execution("start","running"))
  await eventually(()=>started,"first card not started")
  for(let i=0;i<1000;i++)turn.update({...execution("update","running"),job:{...execution("update","running").job,progress:{title:"progress "+i}}})
  turn.update(execution("update","completed"));release();await turn.flush()
  assert.equal(f.writes.length,2);assert.equal(f.writes[0].body.state.input.__display_status,"running");assert.equal(f.writes[1].body.state.input.__display_status,"completed")
  assert.equal(f.writes[1].body.metadata.providerExecuted,true)
})

test("late job completion stays on its original assistant after a new turn starts",async t=>{
  const f=await fixture(t),seen=[];let calls=0,transport
  transport=new NotionTransport({send:async()=>{transport.observeExecution(execution("start","running","job_"+(++calls)));return "done"},interrupt:async()=>{}},f.journal,"context")
  transport.display={begin:async(_session,message)=>({update:e=>seen.push([message,e.job.job_id,e.job.status]),finalText:()=>{},flush:async()=>{}})}
  transport.observeExecution(execution("start","running","outside"))
  await (await request(transport,{message:"msg_first",stream:false})).text()
  await (await request(transport,{message:"msg_second",stream:false})).text()
  transport.observeExecution(execution("update","completed","job_1"));transport.observeExecution(execution("update","failed","job_2"))
  transport.observeExecution(execution("update","completed","outside"))
  assert.deepEqual(seen,[["msg_first","job_1","running"],["msg_second","job_2","running"],["msg_first","job_1","completed"],["msg_second","job_2","failed"]])
})

test("awaiting approval, cancelling and cancelled show exact native display statuses",async()=>{
  const f=displayFixture(),turn=await f.display.begin("ses_s","msg_u")
  for(const status of ["running","awaiting_permission","cancelling","cancelled"]){turn.update(execution(status==="running"?"start":"update",status));await turn.flush()}
  assert.deepEqual(f.writes.map(x=>x.body.state.input.__display_status),["running","awaiting_permission","cancelling","cancelled"])
  assert.equal(f.writes.at(-1).body.state.status,"error");assert.equal(f.writes.at(-1).body.state.error,"cancelled")
})

test("own persisted cards are excluded from model histories without changing stock UI records",async()=>{
  const {attachLiveUI}=await import("../dist/plugin/live.js"),f=displayFixture();let composed=0
  const config=()=>{},hooks=attachLiveUI({client:f.client,directory:"/workspace"},{redactDisplay:s=>s},{config,"experimental.chat.messages.transform":async()=>{composed++}})
  const own={type:"tool",tool:"opencode_mcp.bash",callID:"notion-display-test",metadata:{providerExecuted:true,notionDisplay:{displayOnly:true}}}
  const ordinary={type:"tool",tool:"bash",callID:"ordinary"},plain={type:"text",text:"answer"}
  const messages=[{info:{role:"assistant",providerID:"notion-ai"},parts:[own,ordinary,plain]},{info:{role:"assistant",providerID:"other"},parts:[ordinary]}],output={messages}
  await hooks["experimental.chat.messages.transform"]({},output)
  assert.equal(hooks.config,config);assert.equal(composed,1);assert.deepEqual(output.messages[0].parts,[ordinary,plain]);assert.equal(messages[0].parts.length,3);assert.equal(output.messages[1],messages[1])
  await hooks.dispose()
})

test("live native progress metadata holds credential prefixes until they can be redacted",async()=>{
  const f=displayFixture(),turn=await f.display.begin("ses_s","msg_u")
  turn.update(execution("start","running"));await turn.flush()
  const event=execution("update","running");event.job.progress={title:"COOKIE_",metadata:{output:"MCP_SEC"}}
  turn.update(event);await turn.flush()
  assert.doesNotMatch(JSON.stringify(f.writes),/COOKIE_|MCP_SEC/)
  turn.update(execution("update","completed"));await turn.flush();assert.match(f.writes.at(-1).body.state.output,/\[redacted\]/)
})
