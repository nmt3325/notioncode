import assert from 'node:assert/strict'
import { test } from 'node:test'
import { InferenceText } from '../dist/vendor/notion-ai/inference-stream.js'
const text = content => ({type:'text', content})
const snap = (id,...values) => ({type:'agent-inference',id,value:values})
const patch = (...v) => ({type:'patch',v})
const op = (p,v,o='a') => ({p,v,o})
const send = (p,...events) => {for(const event of events)p.line(JSON.stringify(event))}
test('numeric workflow slots bind to stable snapshot IDs before text deltas',()=>{
 const p=new InferenceText()
 send(p,snap('stable-a',text('A'),{type:'thinking',content:'HIDDEN'}),patch(op('/s/0/id','stable-a'),op('/s/0/value/0/content','B','x'),op('/s/0/value/1/content','HIDDEN','x')))
 assert.equal(p.result().text,'AB');send(p,snap('stable-a',text('AB')));assert.equal(p.result().text,'AB')
})
test('whole-step append patches retain numeric routing and one text copy per stable ID',()=>{
 const p=new InferenceText()
 send(p,patch(op('/s/-',snap('first',text('A'))),op('/s/-',snap('second',text('C')))),patch(op('/s/0/value/0/content','B','x')),snap('first',text('AB')))
 assert.equal(p.result().text,'AB\n\nC')
})
test('late slot identities merge newer entry edits without dropping other public entries',()=>{
 const p=new InferenceText()
 send(p,snap('stable',text('first'),text('old tail')),patch(op('/s/0/value/1',text('new tail'))),patch(op('/s/0/id','stable')))
 assert.equal(p.result().text,'first\n\nnew tail');send(p,snap('stable',text('replacement')));assert.equal(p.result().text,'replacement')
})
test('a newer full snapshot clears older unmatched slot entries when identity arrives late',()=>{
 const p=new InferenceText()
 send(p,snap('stable',text('first'),text('old tail')),patch(op('/s/0/value/1',text('provisional tail'))),snap('stable',text('replacement')),patch(op('/s/0/id','stable')))
 assert.equal(p.result().text,'replacement')
})
test('reused numeric slots target a new stable inference without erasing its predecessor',()=>{
 const p=new InferenceText()
 send(p,patch(op('/s/0',snap('a',text('A')))),patch(op('/s/0',snap('b',text('B')))),patch(op('/s/0/value/0/content','C','x')))
 assert.equal(p.result().text,'A\n\nBC')
})
test('typed tool steps and similarly named nested value arrays are never displayed',()=>{
 const p=new InferenceText()
 send(p,patch(op('/s/0',{id:'tool',type:'tool-result',value:[text('HIDDEN')]})),patch(op('/s/0/value/-',text('MORE_HIDDEN')),op('/nested/s/1/value/-',text('NESTED_HIDDEN')),op('/s/1/tool/value/-',text('TOOL_HIDDEN'))),patch(op('/s/1',snap('answer',text('visible')))))
 assert.equal(p.result().text,'visible')
})
test('usage-only numeric positions reserve the next append index for the public-text reducer',()=>{
 const p=new InferenceText()
 send(p,patch(op('/s/0/inputTokens',7)),patch(op('/s/-',snap('answer',text('A')))),patch(op('/s/1/value/0/content','B','x')))
 assert.equal(p.result().text,'AB')
})
