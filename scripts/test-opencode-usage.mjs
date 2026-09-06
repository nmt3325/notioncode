#!/usr/bin/env node
/** Real pinned OpenCode + Notion NDJSON mock. No model service, Notion login, or TUI fork. */
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { execFile, execFileSync } from "node:child_process"
import { promisify } from "node:util"
import { bundledBun } from "../dist/plugin/config.js"
const exec = promisify(execFile), project = resolve(import.meta.dirname, "..")
const source = process.env.OPENCODE_MCP_RUNTIME_DIR ?? join(project, ".opencode-runtime")
const bun = process.env.OPENCODE_MCP_BUN ?? bundledBun()
assert.equal(execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), "16747470f976aca3d362ad730bcd3fe82ecc2c9a")
assert.equal(execFileSync(bun, ["--version"], { encoding: "utf8" }).trim(), "1.3.14")
const temp = await mkdtemp(join(tmpdir(), "opencode-usage-host-"))
const uri = path => JSON.stringify(pathToFileURL(path).href)
try {
  const workspace = join(temp, "workspace"), home = join(temp, "home"), journal = join(temp, "journal.json"), log = join(temp, "requests.jsonl"), messages = join(temp, "messages.jsonl")
  await mkdir(workspace); await mkdir(home)
  const plugin = join(temp, "provider.mjs")
  await writeFile(plugin, `
import {providerHooks} from ${uri(join(project, "dist/plugin.js"))};
import {NotionBackend,notionConfig} from ${uri(join(project, "dist/plugin/notion.js"))};
import {NotionTransport} from ${uri(join(project, "dist/plugin/transport.js"))};
import {Journal} from ${uri(join(project, "dist/plugin/storage.js"))};
import {notionUsageOptions,UNKNOWN_NOTION_CONTEXT} from ${uri(join(project, "dist/plugin/usage.js"))};
import {appendFileSync} from 'node:fs';
export default {id:'notion-usage-host-fixture',server:async()=>{
 const journal=new Journal(${JSON.stringify(journal)});await journal.load();
 const cfg=notionConfig({tokenV2:'not-a-real-token',model:'almond-croissant-low',account:{
 user_id:'11111111-1111-4111-8111-111111111111',user_name:'Mock',user_email:'mock@example.invalid',
 space_id:'22222222-2222-4222-8222-222222222222',space_name:'Mock',space_view_id:'33333333-3333-4333-8333-333333333333',timezone:'UTC',client_version:'mock'}},${JSON.stringify(temp)});
 const backend=new NotionBackend(cfg,async(url,init)=>{
  if(!String(url).endsWith('/runInferenceTranscript'))throw Error('Unexpected Notion endpoint (mock only)');
  const body=JSON.parse(init.body),prompt=body.transcript.findLast(s=>s.type==='user').value.flat(Infinity).join('');
  appendFileSync(${JSON.stringify(log)},JSON.stringify({threadId:body.threadId,prompt,partial:body.isPartialTranscript})+'\\n');
  const text='NOTION_USAGE_HOST_REPLY '+prompt;
  const frames=prompt.includes('unknown')?[{type:'agent-inference',id:'last',value:[{type:'text',content:text}]}]:[
   {type:'agent-inference',id:'before',inputTokens:400,outputTokens:30,value:[{type:'thinking',content:'hidden-never-render'}]},
   {type:'agent-inference',id:'before',inputTokens:400,outputTokens:30},
   {type:'agent-inference',id:'last',value:[{type:'text',content:text}]},
   {type:'agent-inference',id:'last',inputTokens:1000,outputTokens:200,cachedTokensRead:300,cachedTokensCreated:40,maxInputTokens:10000,maxContextTokens:12000},
   {type:'agent-inference',id:'last',inputTokens:1000,outputTokens:200,cachedTokensRead:300,cachedTokensCreated:40,maxInputTokens:10000,maxContextTokens:12000}];
  return new Response(frames.map(s=>JSON.stringify(s)).join('\\n'),{headers:{'content-type':'application/x-ndjson'}});
 });
 const transport=new NotionTransport(backend,journal,'host fixture');
 const hooks=providerHooks(transport,()=>transport.close());
 return {...hooks,config:async config=>{
  await hooks.config(config);
  // Verify the production hooks: never repair missing integration in the fixture.
  if(config.provider['notion-ai'].options.includeUsage!==true||config.provider['notion-ai'].options.metadataExtractor!==notionUsageOptions.metadataExtractor)throw Error('Production usage options missing');
  for(const model of Object.values(config.provider['notion-ai'].models))if(model.limit.context!==UNKNOWN_NOTION_CONTEXT||model.limit.output!==0)throw Error('Unverified model limits were restored');
 },event:async({event})=>{
  if(event.type==='message.updated'&&event.properties.info.role==='assistant'){
   const {id,parentID,providerID,modelID,tokens,cost,finish}=event.properties.info;
   appendFileSync(${JSON.stringify(messages)},JSON.stringify({id,parentID,providerID,modelID,tokens,cost,finish})+'\\n');
  }
 }};
}};
`)
  await writeFile(join(workspace, "opencode.json"), JSON.stringify({ plugin: [pathToFileURL(plugin).href] }))
  const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"), XDG_CACHE_HOME: join(home, "cache"),
    OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_DISABLE_CLAUDE_CODE: "true", OPENCODE_DISABLE_EXTERNAL_SKILLS: "true" }
  async function run(args) {
    const pending = exec(bun, [join(source, "packages/opencode/src/index.ts"), "run", "--format", "json", ...args], { cwd: workspace, env, timeout: 90000, maxBuffer: 4 * 1024 * 1024 })
    pending.child.stdin.end() // OpenCode intentionally waits on stdin otherwise.
    return pending
  }
  const parse = text => text.split("\n").flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
  const first = await run(["measured"])
  assert.match(first.stdout, /NOTION_USAGE_HOST_REPLY/)
  assert.equal(first.stdout.includes("hidden-never-render"), false)
  const events = parse(first.stdout), session = events.find(e => e.sessionID)?.sessionID
  assert.ok(session, "real OpenCode must create a session")
  const finish = events.find(e => e.type === "step_finish" && e.part?.tokens?.output === 200)
  assert.ok(finish, `no real step-finish usage event: ${first.stdout}`)
  assert.deepEqual(finish.part.tokens, { total: 1240, input: 700, output: 200, reasoning: 0, cache: { read: 300, write: 40 } })
  assert.equal(finish.part.cost, 0, "native $0 is an unpriced placeholder, never a Notion charge")
  const second = await run(["--session", session, "unknown"])
  assert.match(second.stdout, /NOTION_USAGE_HOST_REPLY/)
  const calls = parse(await readFile(log, "utf8"))
  assert.equal(calls.length, 2); assert.equal(calls[0].threadId, calls[1].threadId)
  assert.equal(calls[0].partial, false); assert.equal(calls[1].partial, true)
  const nativeMessages = parse(await readFile(messages, "utf8"))
  const measuredMessage = nativeMessages.findLast(m => m.tokens?.output === 200)
  assert.ok(measuredMessage, "native message.updated must carry the same data used by the sidebar")
  assert.deepEqual(measuredMessage.tokens, finish.part.tokens)
  const unknownMessage = nativeMessages.findLast(m => m.id !== measuredMessage.id && m.finish === "stop")
  assert.ok(unknownMessage); assert.equal(unknownMessage.tokens.input, 0); assert.equal(unknownMessage.tokens.output, 0)
  const stored = JSON.parse(await readFile(journal, "utf8")), turns = Object.values(Object.values(stored.sessions)[0].turns)
  assert.equal(turns.length, 2); assert.equal(turns[0].usage.source, "notion-inference"); assert.equal("usage" in turns[1], false)
  assert.equal(turns[0].usage.observedTotals.inputTokens, 1400)
  assert.equal(turns[0].usage.lastInference.inputTokens, 1000)

  // Execute the actual pinned sidebar state callback (not a rewritten approximation).
  // Only remove its surrounding Solid memo; do not edit upstream source or render a replacement UI.
  const sidebar = await readFile(join(source, "packages/tui/src/feature-plugins/sidebar/context.tsx"), "utf8")
  const callback = sidebar.match(/const state = createMemo\(\(\) => \{([\s\S]*?)\n  \}\)/)?.[1]
  assert.ok(callback); assert.match(sidebar, /state\(\)\.percent \?\? 0/)
  const stateCheck = join(temp, "sidebar-state.ts")
  await writeFile(stateCheck, `
import assert from 'node:assert/strict';
function state(msg:any,props:any){${callback}\n}
const measured=${JSON.stringify({ ...measuredMessage, role: "assistant" })};
const unknown=${JSON.stringify({ ...unknownMessage, role: "assistant" })};
const props=(limit:number)=>({api:{state:{provider:[{id:'notion-ai',models:{chat:{limit:{context:limit}}}}]}}});
assert.deepEqual(state(()=>[measured],props(0)),{tokens:1240,percent:null});
assert.deepEqual(state(()=>[measured],props(10000)),{tokens:1240,percent:12});
assert.deepEqual(state(()=>[measured,unknown],props(0)),{tokens:1240,percent:null});
assert.deepEqual(state(()=>[unknown],props(0)),{tokens:0,percent:null});
console.log('PASS: unchanged sidebar calculation with native SDK messages; unknown percent is null (UI still displays its 0% placeholder)');
`)
  const checked = await exec(bun, [stateCheck], { cwd: workspace, env, timeout: 15000 })
  console.log(checked.stdout.trim())
  console.log("PASS: mocked Notion NDJSON -> actual backend -> durable journal -> SSE usage-only frame -> pinned OpenAI SDK -> native step_finish + message.updated")
  console.log("Measured native tokens:", JSON.stringify(finish.part.tokens))
  console.log("PASS: repeated cumulative frames counted once; latest inference not whole-turn sum; no-usage second turn remains absent in journal")
  console.log("LIMIT: no live Notion account or TUI screenshot; native missing counters/$/% placeholders cannot be relabelled by this server-only plugin")
} finally { await rm(temp, { recursive: true, force: true }) }
