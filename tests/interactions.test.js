import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldUseCard, isEditable, prepareCard, SHORTCUTS } from '../ui/interactions.js';
const card = { ownerDocument: { getSelection: () => ({isCollapsed:true}) } };
function event(overrides = {}) { return {button:0,target:{closest:()=>null},...overrides}; }
test('card activation accepts ordinary left click only', () => {
  assert.equal(shouldUseCard(event(),card),true);
  for (const flag of ['defaultPrevented','metaKey','ctrlKey','altKey','shiftKey']) assert.equal(shouldUseCard(event({[flag]:true}),card),false);
  for (const button of [1,2]) assert.equal(shouldUseCard(event({button}),card),false);
});
test('card activation preserves nested controls and text selection', () => {
  assert.equal(shouldUseCard(event({target:{closest:()=>({})}}),card),false);
  assert.equal(shouldUseCard(event(),{ownerDocument:{getSelection:()=>({isCollapsed:false})}}),false);
});
test('editable predicate follows closest editable ancestor', () => {
  assert.equal(isEditable({closest:()=>({})}),true);
  assert.equal(isEditable({closest:()=>null}),false);
  assert.equal(isEditable(null),false);
});
test('card is a labelled keyboard group without nesting buttons', () => {
  const attributes = {}; const element = {setAttribute:(k,v)=>{attributes[k]=v;}};
  prepareCard(element,{title:'Demo'},{variable:true});
  assert.equal(element.tabIndex,0); assert.equal(attributes.role,'group');
  assert.match(attributes['aria-label'],/填写变量/);
  assert.ok(SHORTCUTS.some(item=>item.keys==='Alt + N'));
});
