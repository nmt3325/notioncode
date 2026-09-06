#!/usr/bin/env node
/** Explicit opt-in only. Makes ONE read-only Notion inference; never run this in CI. */
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, realpath } from "node:fs/promises"
import { dirname, join, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { execFile, execFileSync } from "node:child_process"
import { promisify } from "node:util"
import { bundledBun } from "../dist/plugin/config.js"
import { readNotionUsage } from "../dist/vendor/notion-ai/usage.js"
import { openAIUsage, reportedContext } from "../dist/plugin/usage.js"
const project = resolve(import.meta.dirname, ".."), exec = promisify(execFile)
const source = process.env.OPENCODE_MCP_RUNTIME_DIR ?? join(project, ".opencode-runtime")
const bun = process.env.OPENCODE_MCP_BUN ?? bundledBun()
const tokenFile = process.env.NOTION_USAGE_LIVE_TOKEN_FILE, spaceId = process.env.NOTION_USAGE_LIVE_SPACE_ID
if (process.env.NOTION_USAGE_LIVE_ALLOW !== "yes" || !tokenFile || !spaceId) throw Error("Live test requires explicit opt-in, an external token JSON file and the target workspace ID; never pass a token on the command line")
const credentialPath = await realpath(resolve(tokenFile))
const repositoryPath = await realpath(project)
if (credentialPath === repositoryPath || credentialPath.startsWith(repositoryPath + sep)) throw Error("Credential input must remain outside the repository")
assert.equal(execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), "16747470f976aca3d362ad730bcd3fe82ecc2c9a")
assert.equal(execFileSync(bun, ["--version"], { encoding: "utf8" }).trim(), "1.3.14")
const temp = await mkdtemp(join(dirname(resolve(tokenFile)), "native-live-")); await chmod(temp, 0o700)
const uri = path => JSON.stringify(pathToFileURL(path).href)
const parse = text => text.split("\n").flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
const report = { mode: "live-read-only", nativeHost: "OpenCode 1.18.29 / Bun 1.3.14", credentialsLogged: false, accountPagesEdited: false, connectionsAdded: false }
let stage = "prepare", failed = false
try {
  const workspace = join(temp, "workspace"), home = join(temp, "home"), journal = join(temp, "journal.json"), network = join(temp, "network.jsonl"), messages = join(temp, "messages.jsonl"), diagnostic = join(temp, "numeric-protocol.json")
  await mkdir(workspace, { mode: 0o700 }); await mkdir(home, { mode: 0o700 })
  const plugin = join(temp, "provider.mjs")
  await writeFile(plugin, `
import {providerHooks} from ${uri(join(project, "dist/plugin.js"))};
import {NotionBackend,notionConfig} from ${uri(join(project, "dist/plugin/notion.js"))};
import {NotionTransport} from ${uri(join(project, "dist/plugin/transport.js"))};
import {Journal} from ${uri(join(project, "dist/plugin/storage.js"))};
import {notionUsageOptions,UNKNOWN_NOTION_CONTEXT} from ${uri(join(project, "dist/plugin/usage.js"))};
import {InferenceUsageCollector} from ${uri(join(project, "dist/vendor/notion-ai/usage.js"))};
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
export default {id:'notion-live-usage-fixture',server:async()=>{
 const auth=JSON.parse(readFileSync(${JSON.stringify(credentialPath)},'utf8'));
 if(typeof auth.tokenV2!=='string'||!auth.tokenV2)throw Error('Temporary credential unavailable');
 const journal=new Journal(${JSON.stringify(journal)});await journal.load();
 const cfg=notionConfig({tokenV2:auth.tokenV2,model:'default',account:{space_id:${JSON.stringify(spaceId)}}},${JSON.stringify(temp)});
 cfg.requestTimeoutMs=120000;cfg.defaultWebSearch=false;cfg.defaultWorkspaceSearch=false;cfg.defaultReadOnly=true;
 let inferences=0;
 const backend=new NotionBackend(cfg,async(url,init)=>{
  const target=new URL(String(url)),endpoint=target.pathname.split('/').at(-1);
  if(target.protocol!=='https:'||target.hostname!=='app.notion.com'||!['loadUserContent','runInferenceTranscript'].includes(endpoint))throw Error('Live-test endpoint guard blocked an unrelated operation');
  if(endpoint==='runInferenceTranscript'){
   if(++inferences>1)throw Error('Live test permits one inference only');
   writeFileSync(${JSON.stringify(join(temp, "inference-dispatched"))},'one',{flag:'wx',mode:0o600});
   const body=JSON.parse(init.body),config=body.transcript.find(s=>s.type==='config')?.value;
   if(!config?.useReadOnlyMode)throw Error('Read-only request guard failed');
  }
  const response=await fetch(url,{...init,redirect:'error'});
  appendFileSync(${JSON.stringify(network)},JSON.stringify({endpoint,status:response.status})+'\\n',{mode:0o600});
  if(endpoint!=='runInferenceTranscript'||!response.body)return response;
  const collector=new InferenceUsageCollector(),decoder=new TextDecoder(),eventTypes={},tokenFrames=[];
  let buffer='',visibleTextEntries=0;
  const keys=['inputTokens','outputTokens','cachedTokensRead','cachedTokensCreated','maxInputTokens','maxContextTokens'];
  const observe=line=>{try{
   line=line.trim();if(line.startsWith('data:'))line=line.slice(5).trim();
   if(!line||line==='[DONE]')return;
   const e=JSON.parse(line);collector.observe(e);
   const type=typeof e.type==='string'?e.type:'unknown';eventTypes[type]=(eventTypes[type]??0)+1;
   if(type==='agent-inference'){
    visibleTextEntries+=(Array.isArray(e.value)?e.value:[]).filter(v=>v?.type==='text'&&typeof v.content==='string'&&v.content.length>0).length;
    const fields=Object.fromEntries(keys.filter(k=>typeof e[k]==='number').map(k=>[k,e[k]]));
    if(Object.keys(fields).length&&tokenFrames.length<30)tokenFrames.push({type,fields});
   }
   for(const op of Array.isArray(e.v)?e.v:[]){
    if(typeof op?.p!=='string')continue;
    if(op.p.startsWith('/s/')&&op.p.endsWith('/value/-')&&op.v?.type==='text')visibleTextEntries++;
    const field=op.p.split('/').at(-1);
    if(keys.includes(field)&&typeof op.v==='number'&&tokenFrames.length<30)tokenFrames.push({type:'patch',field,operation:op.o,value:op.v});
   }
  }catch{}};
  const stream=response.body.pipeThrough(new TransformStream({transform(chunk,c){
   buffer+=decoder.decode(chunk,{stream:true});let end;
   while((end=buffer.indexOf('\\n'))>=0){observe(buffer.slice(0,end));buffer=buffer.slice(end+1)}
   c.enqueue(chunk);
  },flush(){buffer+=decoder.decode();if(buffer)observe(buffer);
   writeFileSync(${JSON.stringify(diagnostic)},JSON.stringify({eventTypes,visibleTextEntries,tokenFrames,usage:collector.result()}),{mode:0o600});
  }}));
  return new Response(stream,{status:response.status,statusText:response.statusText,headers:response.headers});
 });
 // Restrict only this verification turn; production backend logic is otherwise unchanged.
 const chat=backend.client.chat.bind(backend.client);
 backend.client.chat=options=>chat({...options,readOnly:true,webSearch:false,workspaceSearch:false});
 const transport=new NotionTransport(backend,journal,'Verification only. Never use tools, search, or modify any document or connection.');
 const hooks=providerHooks(transport,()=>transport.close());
 return {...hooks,config:async config=>{
  await hooks.config(config);Object.assign(config.provider['notion-ai'].options,notionUsageOptions);
  for(const model of Object.values(config.provider['notion-ai'].models))model.limit={...model.limit,context:UNKNOWN_NOTION_CONTEXT,output:0};
 },event:async({event})=>{
  if(event.type==='message.updated'&&event.properties.info.role==='assistant'&&event.properties.info.providerID==='notion-ai'){
   const {tokens,cost,finish}=event.properties.info;
   appendFileSync(${JSON.stringify(messages)},JSON.stringify({tokens,cost,finish})+'\\n',{mode:0o600});
  }
 }};
}};
`, { mode: 0o600 })
  await writeFile(join(workspace, "opencode.json"), JSON.stringify({ plugin: [pathToFileURL(plugin).href] }), { mode: 0o600 })
  const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"), XDG_CACHE_HOME: join(home, "cache"),
    OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_DISABLE_CLAUDE_CODE: "true", OPENCODE_DISABLE_EXTERNAL_SKILLS: "true" }
  stage = "native-live-turn"
  const pending = exec(bun, [join(source, "packages/opencode/src/index.ts"), "run", "--format", "json", "Verification only. Do not use tools or search. Reply with exactly NOTION_USAGE_LIVE_OK."], { cwd: workspace, env, timeout: 150000, maxBuffer: 4 * 1024 * 1024 })
  pending.child.stdin.end()
  let output
  try { output = await pending } catch { output = { stdout: "" }; failed = true }
  const events = parse(output.stdout)
  const requests = parse(await readFile(network, "utf8").catch(() => ""))
  report.requests = requests
  const diag = JSON.parse(await readFile(diagnostic, "utf8").catch(() => "{}"))
  report.protocol = diag
  report.visibleReplyConfirmed = events.some(e => e.type === "text" && e.part?.text?.includes("NOTION_USAGE_LIVE_OK"))
  const finishes = events.filter(e => e.type === "step_finish")
  report.nativeStepTokens = finishes.at(-1)?.part?.tokens
  const nativeMessages = parse(await readFile(messages, "utf8").catch(() => ""))
  report.nativeMessageTokens = nativeMessages.findLast(m => m.finish)?.tokens
  const state = JSON.parse(await readFile(journal, "utf8").catch(() => '{"sessions":{}}'))
  const turns = Object.values(state.sessions).flatMap(s => Object.values(s.turns))
  report.turnStatuses = turns.map(t => t.status)
  const usage = readNotionUsage(turns.find(t => t.status === "complete")?.usage)
  report.reportedUsage = usage
  report.reportedContext = reportedContext(usage)
  report.standardUsageAvailable = openAIUsage(usage) !== undefined
  stage = "verify-native-counters"
  if (report.standardUsageAvailable) {
    const wire = openAIUsage(usage), last = usage.lastInference
    const expected = { total: wire.total_tokens, input: last.inputTokens - (last.cachedTokensRead ?? 0), output: last.outputTokens, reasoning: 0,
      cache: { read: last.cachedTokensRead ?? 0, write: last.cachedTokensCreated ?? 0 } }
    assert.deepEqual(report.nativeStepTokens, expected)
    assert.deepEqual(report.nativeMessageTokens, expected)
    report.nativeCountersMatch = true
  }
  report.limitWarning = "Native missing counters, 0% and $0 are placeholders; optional reported context is not dynamically installed in the model registry."
  assert.equal(requests.filter(r => r.endpoint === "runInferenceTranscript").length, 1)
  assert.equal(report.visibleReplyConfirmed, true)
  assert.equal(failed, false)
  report.status = report.standardUsageAvailable ? "passed-live-usage" : "passed-live-chat-usage-not-reported"
} catch {
  failed = true; report.status = "failed"; report.failedStage = stage
} finally {
  await rm(temp, { recursive: true, force: true })
  console.log(JSON.stringify(report, null, 2))
  if (process.env.NOTION_USAGE_LIVE_RESULT_FILE) await writeFile(process.env.NOTION_USAGE_LIVE_RESULT_FILE, JSON.stringify(report, null, 2), { mode: 0o600 })
}
if (failed) process.exitCode = 1
