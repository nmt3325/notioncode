import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createServer } from "node:http"
import { bundledBun } from "../dist/plugin/config.js"
import { NotionModels } from "../dist/plugin/models.js"
const exec=promisify(execFile), project=resolve(import.meta.dirname,"..")
const source=process.env.OPENCODE_MCP_RUNTIME_DIR ?? join(project,".opencode-runtime"), bun=process.env.OPENCODE_MCP_BUN ?? bundledBun()
const temp=await mkdtemp(join(tmpdir(),"opencode-live-host-"))
async function freePort(){const server=createServer();await new Promise(r=>server.listen(0,"127.0.0.1",r));const port=server.address().port;await new Promise(r=>server.close(r));return port}
try {
  const workspace=join(temp,"workspace"), home=join(temp,"home"), state=join(temp,"state"), trace=join(temp,"trace.jsonl"), fixture=join(temp,"provider.mjs")
  await mkdir(workspace);await mkdir(home);await symlink(join(project,"node_modules"),join(temp,"node_modules"),"dir")
  const accountFile=join(temp,"account.json"),port=await freePort()
  await writeFile(accountFile,JSON.stringify({token_v2:"LIVE_COOKIE_SECRET"}),{mode:0o600})
  const moduleUrl=path=>JSON.stringify(pathToFileURL(join(project,path)).href)
  await writeFile(fixture, `
import {providerHooks} from ${moduleUrl("dist/plugin.js")};
import {attachLiveUI} from ${moduleUrl("dist/plugin/live.js")};
import {startRuntime} from ${moduleUrl("dist/plugin/runtime.js")};
import {NotionBackend} from ${moduleUrl("dist/plugin/notion.js")};
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {appendFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {join} from 'node:path';
const trace=value=>appendFileSync(${JSON.stringify(trace)},JSON.stringify({...value,time:Date.now()})+'\\n');
export default {id:'notion-live-host-fixture',server:async input=>{
 const account={tokenV2:'LIVE_COOKIE_SECRET',userId:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',spaceId:'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',userName:'Fixture',userEmail:'fixture@example.com',spaceName:'Fixture',spaceViewId:'cccccccc-cccc-4ccc-cccc-cccccccccccc',timezone:'UTC'};
 const records=[];let bearer='',mcp,revision=false;
 const manager={list:async()=>records,status:async()=>({status:'connected'}),
  add:async config=>{bearer=config.auth.token;const entry={...config,id:'dddddddd-dddd-4ddd-dddd-dddddddddddd',linked:true,enabledToolNames:null};records.push(entry);return entry},
  update:async(id,config)=>{if(config.auth)bearer=config.auth.token;Object.assign(records.find(x=>x.id===id),config);return records.find(x=>x.id===id)}};
 const tool=async(name,args)=>{
  const result=await mcp.callTool({name,arguments:args});
  let job=result.structuredContent??JSON.parse(result.content.find(x=>x.type==='text').text);
  for(let i=0;i<40&&['running','cancelling'].includes(job.status);i++) {const r=await mcp.callTool({name:'opencode_job_result',arguments:{job_id:job.job_id,wait_seconds:1}});job=r.structuredContent??JSON.parse(r.content.find(x=>x.type==='text').text)}
  trace({type:'native.result',name,status:job.status});return job;
 };
 const factory=config=>{
  const backend=new NotionBackend({...config,account},async(url,init)=>{
   if(!String(url).endsWith('/runInferenceTranscript'))throw new Error('Unexpected mocked Notion endpoint');
   const body=JSON.parse(init.body);trace({type:'notion.request',conversation:body.threadId,model:body.transcript.find(x=>x.type==='config').value.model});
   const encoder=new TextEncoder();let controller;
   const stream=new ReadableStream({start(c){controller=c}});
   const emitEvent=event=>controller.enqueue(encoder.encode(JSON.stringify(event)+'\\n'));
   const emit=text=>emitEvent({type:'agent-inference',id:'answer',value:[{type:'thinking',content:'HIDDEN_REASONING_MARKER'},{type:'text',content:text}]});
   void (async()=>{
    emit('LIVE_PROG');emit('LIVE_PROG');
    emitEvent({type:'patch',v:[{o:'a',p:'/s/0/id',v:'answer'},{o:'x',p:'/s/0/value/1/content',v:'RESS'},{o:'x',p:'/s/0/value/0/content',v:'HIDDEN_REASONING_MARKER'}]});
    await delay(400);
    const written=await tool('write',{filePath:join(input.directory,'live.txt'),content:'native write'});if(written.status!=='completed')throw Error('write failed');
    const shell=await tool('bash',{command:'printf LIVE_NATIVE_RESULT; sleep 0.4; printf x >> execution-count',description:'One real native execution',timeout:10000});if(shell.status!=='completed')throw Error('bash failed');
    await tool('read',{filePath:join(input.directory,'missing-file.txt')});
    trace({type:'notion.final'});emit((revision?'LIVE_REVISED_FINAL ':'LIVE_PROGRESS\\n\\nLIVE_FINAL ')+'LIVE_COOKIE_SECRET '+bearer);
    const counts={inputTokens:revision?2000:1000,outputTokens:revision?220:200,cachedTokensRead:revision?600:300,cachedTokensCreated:40,maxInputTokens:10000,maxContextTokens:12000};
    const metrics={type:'patch',v:Object.entries(counts).map(([key,value])=>({o:'a',p:'/s/0/'+key,v:value}))};emitEvent(metrics);emitEvent(metrics);controller.close();
   })().catch(error=>controller.error(error));
   return new Response(stream,{headers:{'content-type':'application/x-ndjson'}});
  });
  return {client:{account:async()=>account,mcp:()=>manager},withTimeout:async(_ms,fn)=>fn(),send:input=>{revision=!input.fresh;return backend.send(input)},interrupt:id=>backend.interrupt(id)};
 };
 const runtime=await startRuntime(input.directory,{publicUrl:['https:','','fixture.example','mcp'].join('/'),accountFile:${JSON.stringify(accountFile)},stateDir:${JSON.stringify(state)},runtimeDir:${JSON.stringify(source)},port:${port},autoSetup:false},factory);
 mcp=new Client({name:'mocked-notion-live',version:'1'});await mcp.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:${port}/mcp'),{requestInit:{headers:{Authorization:'Bearer '+bearer}}}));
 const hooks=providerHooks(runtime.transport,async()=>{await mcp.close();await runtime.close()});
 hooks['tool.execute.before']=async input=>trace({type:'local.tool.execution',tool:input.tool});
 hooks.event=async({event})=>{if(['message.updated','message.part.updated','message.part.delta'].includes(event.type))trace({type:'host.event',event})};
 return attachLiveUI(input,runtime.transport,hooks);
}};
`)
  await writeFile(join(workspace,"opencode.json"),JSON.stringify({plugin:[pathToFileURL(fixture).href]}))
  const env={PATH:process.env.PATH,HOME:home,XDG_CONFIG_HOME:join(home,"config"),XDG_DATA_HOME:join(home,"data"),XDG_STATE_HOME:join(home,"state"),XDG_CACHE_HOME:join(home,"cache"),
    OPENCODE_DISABLE_MODELS_FETCH:"true",OPENCODE_DISABLE_DEFAULT_PLUGINS:"true",OPENCODE_DISABLE_CLAUDE_CODE:"true",OPENCODE_DISABLE_EXTERNAL_SKILLS:"true"}
  async function run(args){const pending=exec(bun,[join(source,"packages/opencode/src/index.ts"),"run","--format","json",...args],{cwd:workspace,env,timeout:120000,maxBuffer:6*1024*1024});pending.child.stdin.end();return pending}
  const first=await run(["--model","notion-ai/gpt-5.4","first-live-turn"]);assert.match(first.stdout,/LIVE_FINAL/)
  const stdout=first.stdout.split("\n").flatMap(x=>{try{return [JSON.parse(x)]}catch{return []}}),session=stdout.find(x=>x.sessionID)?.sessionID
  assert.ok(session);const second=await run(["--session",session,"--model","notion-ai/claude-opus-4.6-medium","second-live-turn"]);assert.match(second.stdout,/LIVE_REVISED_FINAL/)
  const log=await readFile(trace,"utf8"), rows=log.trim().split("\n").map(x=>JSON.parse(x))
  const requests=rows.filter(x=>x.type==="notion.request"), finals=rows.filter(x=>x.type==="notion.final")
  assert.equal(rows.filter(x=>x.type==="local.tool.execution").length,0);
  assert.equal(requests.length,2);assert.equal(requests[0].conversation,requests[1].conversation);assert.equal(finals.length,2)
  const models=new NotionModels();assert.equal(requests[0].model,models.resolve("gpt-5.4"));assert.equal(requests[1].model,models.resolve("claude-opus-4.6-medium"))
  const host=rows.filter(x=>x.type==="host.event"), deltas=host.filter(x=>x.event.type==="message.part.delta")
  assert.ok(deltas.filter(x=>x.time<finals[0].time).map(x=>x.event.properties.delta).join("").includes("LIVE_PROGRESS"),"standard host must receive public text before upstream completes")
  const parts=host.filter(x=>x.event.type==="message.part.updated").map(x=>({part:x.event.properties.part,time:x.time})), tools=parts.filter(x=>x.part.type==="tool")
  assert.ok(tools.some(x=>x.part.state.status==="running"&&x.time<finals[0].time),"tool running card must arrive before completion")
  assert.ok(tools.some(x=>x.part.state.status==="completed"&&x.part.state.output.includes("LIVE_NATIVE_RESULT")),"native output must reach standard tool cards")
  assert.ok(tools.some(x=>x.part.state.status==="error"),"failed native read must reach error state")
  const assistants=host.filter(x=>x.event.type==="message.updated"&&x.event.properties.info.role==="assistant").map(x=>x.event.properties.info)
  const assistantIDs=new Set(assistants.map(x=>x.id)),userIDs=new Set(host.filter(x=>x.event.type==="message.updated"&&x.event.properties.info.role==="user").map(x=>x.event.properties.info.id))
  assert.equal(assistantIDs.size,2,"display cards must not trigger another local model step");assert.ok(assistants.every(x=>!x.error),"host assistant must not fail")
  for(const [modelID,input,output,read] of [["gpt-5.4",700,200,300],["claude-opus-4.6-medium",1400,220,600]]) {
    const done=assistants.findLast(x=>x.modelID===modelID&&x.finish==="stop");assert.ok(done);
    assert.deepEqual(done.tokens,{total:input+output+read+40,input,output,reasoning:0,cache:{read,write:40}});assert.equal(done.cost,0);
  }
  assert.equal(new Set(tools.map(x=>x.part.messageID)).size,2)
  for(const {part} of tools){
    assert.ok(assistantIDs.has(part.messageID));assert.ok(!userIDs.has(part.messageID));assert.equal(part.sessionID,session)
    assert.equal(part.metadata.notionDisplay.displayOnly,true);assert.equal(part.metadata.providerExecuted,true)
    assert.ok(["bash","read","write"].includes(part.tool),`unexpected native tool: ${part.tool}`)
    assert.ok(part.state.metadata.executionStatus);assert.equal("__display_status" in part.state.input,false)
  }
  // Exact native names select the host's built-in renderers. Check the latest
  // state of each distinct card, not the number or order of update events.
  for(const assistantID of assistantIDs){
    const cards=new Map(tools.filter(x=>x.part.messageID===assistantID).map(x=>[x.part.id,x.part]))
    assert.deepEqual([...cards.values()].map(part=>[part.tool,part.state.status]).sort(([a],[b])=>a.localeCompare(b)),
      [["bash","completed"],["read","error"],["write","completed"]],
      "each assistant must show the native write/bash/read cards with their final states")
  }
  const texts=parts.filter(x=>x.part.type==="text"&&x.part.time?.end).map(x=>x.part.text)
  assert.deepEqual(texts,["LIVE_PROGRESS\n\nLIVE_FINAL [redacted] [redacted]","LIVE_REVISED_FINAL [redacted] [redacted]"])
  assert.equal(await readFile(join(workspace,"execution-count"),"utf8"),"xx","no duplicate native execution or local tool loop")
  assert.equal(await readFile(join(workspace,"live.txt"),"utf8"),"native write")
  const accountDirs=await readdir(join(state,"accounts"));const secret=JSON.parse(await readFile(join(state,"accounts",accountDirs[0],"execution-secret.json"),"utf8")).token
  assert.ok(!log.includes(secret));assert.doesNotMatch(log+first.stdout+second.stdout,/LIVE_COOKIE_SECRET|HIDDEN_REASONING_MARKER/)
  assert.ok(!first.stdout.includes('"tool_calls"')&&!second.stdout.includes('"tool_calls"'))
  console.log("PASS: real pinned OpenCode host receives live NDJSON text, native running/completed/error tool cards, safe results, exact assistant correlation, continuation, reported usage and no duplicate execution")
} catch(error) {
  if(process.env.KEEP_LIVE_TEST_ARTIFACTS)console.error("Live host fixture retained:",temp)
  if(error.stdout)console.error(String(error.stdout).slice(-6000));if(error.stderr)console.error(String(error.stderr).slice(-6000));throw error
} finally {if(!process.env.KEEP_LIVE_TEST_ARTIFACTS)await rm(temp,{recursive:true,force:true})}
