#!/usr/bin/env node
/** Opt-in, one real image upload + read-only inference through the pinned native OpenCode host. Never run in CI. */
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, chmod } from "node:fs/promises"
import { dirname, join, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { execFile, execFileSync } from "node:child_process"
import { promisify } from "node:util"
import { bundledBun } from "../dist/plugin/config.js"
const project = resolve(import.meta.dirname, ".."), exec = promisify(execFile)
if (process.env.NOTION_MODEL_LIVE_ALLOW !== "yes" || !process.env.NOTION_MODEL_LIVE_ACCOUNT_FILE) throw Error("Explicit opt-in and an external account JSON file are required; never pass cookies on the command line")
const credential = await realpath(process.env.NOTION_MODEL_LIVE_ACCOUNT_FILE), repo = await realpath(project)
if (credential === repo || credential.startsWith(repo + sep)) throw Error("Credentials must stay outside the repository")
const source = process.env.OPENCODE_MCP_RUNTIME_DIR ?? join(project, ".opencode-runtime"), bun = process.env.OPENCODE_MCP_BUN ?? bundledBun()
assert.equal(execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), "16747470f976aca3d362ad730bcd3fe82ecc2c9a")
assert.equal(execFileSync(bun, ["--version"], { encoding: "utf8" }).trim(), "1.3.14")
const model = process.env.NOTION_MODEL_LIVE_MODEL ?? "gpt-6-astra", effort = process.env.NOTION_MODEL_LIVE_EFFORT ?? "high"
const image = resolve(process.env.NOTION_MODEL_LIVE_IMAGE ?? join(project, "test/fixtures/image-probe.png"))
const expected = JSON.parse(await readFile(process.env.NOTION_MODEL_LIVE_EXPECTED ?? join(project, "test/fixtures/image-probe.json"), "utf8"))
const temp = await mkdtemp(join(dirname(credential), "native-image-")); await chmod(temp, 0o700)
const uri = path => JSON.stringify(pathToFileURL(path).href), parse = text => text.split("\n").flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
const report = { nativeHost: "OpenCode 1.18.29 / Bun 1.3.14", model, effort, readOnly: true, credentialsLogged: false }
let stage = "prepare", failed = false
try {
  const workspace = join(temp, "workspace"), home = join(temp, "home"), trace = join(temp, "trace.jsonl"), plugin = join(temp, "provider.mjs")
  await mkdir(workspace, { mode: 0o700 }); await mkdir(home, { mode: 0o700 })
  await writeFile(plugin, `
import {providerHooks} from ${uri(join(project, "dist/plugin.js"))};
import {NotionBackend,notionConfig} from ${uri(join(project, "dist/plugin/notion.js"))};
import {NotionTransport} from ${uri(join(project, "dist/plugin/transport.js"))};
import {NotionModels} from ${uri(join(project, "dist/plugin/models.js"))};
import {MODEL_CATALOG} from ${uri(join(project, "dist/vendor/notion-ai/models.js"))};
import {Journal} from ${uri(join(project, "dist/plugin/storage.js"))};
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
const log=data=>appendFileSync(${JSON.stringify(trace)},JSON.stringify(data)+'\\n',{mode:0o600});
const name=id=>MODEL_CATALOG.find(m=>m.modelId===id)?.displayName??'Unrecognized model';
export default {id:'notion-native-image-check',server:async()=>{
 const supplied=JSON.parse(readFileSync(${JSON.stringify(credential)},'utf8'));
 const auth={...supplied,tokenV2:supplied.tokenV2??supplied.token_v2,spaceId:supplied.spaceId??supplied.space_id};
 if(!auth.tokenV2||!auth.spaceId)throw Error('Account JSON must include tokenV2 and spaceId');
 const models=new NotionModels(${JSON.stringify(model)}),expectedModel=models.resolve(${JSON.stringify(model)});
 const journal=new Journal(${JSON.stringify(join(temp, "journal.json"))});await journal.load();
 const cfg=notionConfig({tokenV2:auth.tokenV2,model:${JSON.stringify(model)},account:{}},${JSON.stringify(temp)});
 cfg.account=auth;cfg.requestTimeoutMs=120000;cfg.defaultReadOnly=true;cfg.defaultWebSearch=false;cfg.defaultWorkspaceSearch=false;
 let configId,dispatches=0;
 const backend=new NotionBackend(cfg,async(url,init)=>{
  const target=new URL(String(url)),api=target.protocol==='https:'&&target.hostname==='app.notion.com',endpoint=target.pathname.split('/').at(-1);
  const allowed=['loadUserContent','runInferenceTranscript','getUploadFileUrlForAssistantChatTranscriptUpload','processAgentAttachment','syncRecordValuesMain','getInferenceTranscriptsForUser'];
  if(api&&!allowed.includes(endpoint))throw Error('Unrelated Notion endpoint blocked');
  if(!api&&(target.protocol!=='https:'||!target.hostname.endsWith('.amazonaws.com')||new Headers(init?.headers).has('cookie')))throw Error('Unsafe signed upload blocked');
  if(endpoint==='getUploadFileUrlForAssistantChatTranscriptUpload'){const body=JSON.parse(init.body);log({kind:'upload',extension:body.name.split('.').at(-1),contentType:body.contentType,contentLength:body.contentLength})}
  if(endpoint==='runInferenceTranscript'){
   if(++dispatches>1)throw Error('One inference only');
   writeFileSync(${JSON.stringify(join(temp, "dispatched"))},'one',{flag:'wx',mode:0o600});
   const body=JSON.parse(init.body),config=body.transcript.find(s=>s.type==='config');configId=config.id;
   if(!config.value.useReadOnlyMode)throw Error('Read-only guard failed');
   log({kind:'request',model:name(config.value.model),modelMatches:config.value.model===expectedModel,effort:config.value.reasoningEffort,attachments:body.transcript.filter(s=>s.type==='attachment').length});
  }
  const response=await fetch(url,{...init,redirect:'error'});
  log({kind:'http',endpoint:api?endpoint:'signedUpload',status:response.status});
  if(!response.ok){const error=await response.clone().json().catch(()=>({}));const detail=[error.name,error.message,error.debugMessage].filter(v=>typeof v==='string').join(': ').replaceAll(auth.tokenV2,'[redacted]').replace(/https?:\\/\\/[^\\s]+/g,'[url]').replace(/[a-f0-9]{8}-[a-f0-9-]{27,}/gi,'[id]').slice(0,600);log({kind:'http-error',detail})}
  if(endpoint!=='runInferenceTranscript'||!response.body)return response;
  const decoder=new TextDecoder(),seen=new Set(),current=new Set([configId]);let buffer='';
  const step=s=>{
   if(!s||!['config','agent-inference'].includes(s.type))return;
   if(s.id)current.add(s.id);
   const data=s.type==='config'?s.value:s;
   if(typeof data?.model!=='string')return;
   const value={kind:'reported',source:s.type,model:name(data.model),modelMatches:data.model===expectedModel,...(typeof data.reasoningEffort==='string'?{effort:data.reasoningEffort}:{})};
   const key=JSON.stringify(value);if(!seen.has(key)){seen.add(key);log(value)}
  };
  const observe=line=>{let e;try{e=JSON.parse(line.trim().replace(/^data:\\s*/,''))}catch{return}
   if(e.type==='record-map'){for(const record of Object.values(e.recordMap?.thread_message??{})){const s=record?.value?.value?.step;if(current.has(s?.id))step(s)}}else step(e);
  };
  const stream=response.body.pipeThrough(new TransformStream({transform(chunk,c){buffer+=decoder.decode(chunk,{stream:true});let end;while((end=buffer.indexOf('\\n'))>=0){observe(buffer.slice(0,end));buffer=buffer.slice(end+1)}c.enqueue(chunk)},flush(){buffer+=decoder.decode();if(buffer)observe(buffer)}}));
  return new Response(stream,{status:response.status,headers:response.headers});
 });
 const chat=backend.client.chat.bind(backend.client);
 backend.client.chat=options=>chat({...options,readOnly:true,webSearch:false,workspaceSearch:false});
 const transport=new NotionTransport(backend,journal,'Verification only. No tools, search, document edits, or connection changes.',text=>text,async()=>{},models);
 const original=transport.fetch;
 transport.fetch=async(input,init)=>{const request=new Request(input,init),body=await request.clone().json();if(body.model!=='metadata')log({kind:'sdk',model:body.model,effort:body.reasoning_effort});return original(request)};
 return providerHooks(transport,()=>transport.close());
}};
`, { mode: 0o600 })
  await writeFile(join(workspace, "opencode.json"), JSON.stringify({ plugin: [pathToFileURL(plugin).href] }), { mode: 0o600 })
  const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"), XDG_CACHE_HOME: join(home, "cache"), OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_DISABLE_CLAUDE_CODE: "true", OPENCODE_DISABLE_EXTERNAL_SKILLS: "true" }
  const prompt = 'Read the attached image. Return only JSON with keys code (the large alphanumeric text), blueCircles (count), redSquares (count). No tools or search. If unavailable, say so; do not guess.'
  stage = "native-image-turn"
  const pending = exec(bun, [join(source, "packages/opencode/src/index.ts"), "run", "--format", "json", "--model", `notion-ai/${model}`, "--variant", effort, "--file", image, "--", prompt], { cwd: workspace, env, timeout: 150000, maxBuffer: 4 * 1024 * 1024 })
  pending.child.stdin.end()
  let stdout = ""
  try { ({ stdout } = await pending) } catch { failed = true }
  const rows = parse(await readFile(trace, "utf8").catch(() => ""))
  report.requests = rows.filter(r => r.kind === "http")
  report.uploads = rows.filter(r => r.kind === "upload")
  report.errors = rows.filter(r => r.kind === "http-error")
  report.sdk = rows.find(r => r.kind === "sdk")
  report.request = rows.find(r => r.kind === "request")
  report.reported = rows.filter(r => r.kind === "reported")
  stage = "verify-image-and-selection"
  const events = parse(stdout), text = events.filter(e => e.type === "text" && typeof e.part?.text === "string").map(e => e.part.text).join("\n").trim().replace(/^```(?:json)?\s*|\s*```$/g, "")
  let result
  try { result = JSON.parse(text) } catch { result = JSON.parse(text.replace(/\\"/g, '"')) }
  assert.deepEqual(result, expected)
  report.imageResult = result
  assert.equal(report.sdk?.effort, effort)
  assert.equal(report.request?.modelMatches, true)
  assert.equal(report.request?.effort, effort)
  assert.equal(report.request?.attachments, 1)
  assert.ok(report.reported.some(r => r.source === "agent-inference" && r.modelMatches))
  assert.ok(report.reported.some(r => r.source === "config" && r.effort === effort))
  assert.ok(report.reported.every(r => r.modelMatches))
  assert.equal(report.requests.filter(r => r.endpoint === "runInferenceTranscript").length, 1)
  assert.ok(report.requests.some(r => r.endpoint === "signedUpload" && [200, 204].includes(r.status)))
  assert.ok(report.requests.some(r => r.endpoint === "processAgentAttachment" && r.status === 200))
  assert.equal(failed, false)
  report.status = "passed-native-model-effort-image"
} catch {
  failed = true; report.status = "failed"; report.failedStage = stage
} finally {
  await rm(temp, { recursive: true, force: true })
  console.log(JSON.stringify(report, null, 2))
  if (process.env.NOTION_MODEL_LIVE_REPORT) await writeFile(process.env.NOTION_MODEL_LIVE_REPORT, JSON.stringify(report, null, 2), { mode: 0o600 })
}
if (failed) process.exitCode = 1
