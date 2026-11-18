'use strict';
// 蓝图节点文本解析：使用从 UE 5.8 FPS 工程（BP_FirstPersonCharacter）真实复制的节点格式
const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../ui/blueprint.js');

const T = [
  'Begin Object Class=/Script/BlueprintGraph.K2Node_Event Name="K2Node_Event_3" ExportPath="/Script/BlueprintGraph.K2Node_Event\'/Game/FirstPerson/Blueprints/BP_FirstPersonCharacter.BP_FirstPersonCharacter:EventGraph.K2Node_Event_3\'"',
  '   EventReference=(MemberParent="/Script/Engine.BlueprintGeneratedClass\'/Game/Input/Touch/BPI_TouchInterface.BPI_TouchInterface_C\'",MemberName="Secondary Thumbstick",MemberGuid=6BC7973542E460F70C9D4A9A249F785F)',
  '   bOverrideFunction=True',
  '   NodePosX=816',
  '   NodePosY=864',
  '   CustomProperties Pin (PinId=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA,PinName="then",Direction="EGPD_Output",PinType.PinCategory="exec",LinkedTo=(K2Node_CallFunction_8 BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB,),)',
  '   CustomProperties Pin (PinId=CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC,PinName="Axis_X",Direction="EGPD_Output",PinType.PinCategory="real",LinkedTo=(K2Node_CallFunction_8 DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD,),)',
  'End Object',
  'Begin Object Class=/Script/BlueprintGraph.K2Node_CallFunction Name="K2Node_CallFunction_8"',
  '   FunctionReference=(MemberParent="/Script/CoreUObject.Class\'/Script/TP_FirstPerson.TP_FirstPersonCharacter\'",MemberName="DoLook")',
  '   NodePosX=1100',
  '   NodePosY=864',
  '   CustomProperties Pin (PinId=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB,PinName="execute",PinType.PinCategory="exec",LinkedTo=(K2Node_Event_3 AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA,),)',
  '   CustomProperties Pin (PinId=DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD,PinName="Yaw",PinType.PinCategory="real",LinkedTo=(K2Node_Event_3 CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC,),)',
  'End Object',
  'Begin Object Class=/Script/UnrealEd.EdGraphNode_Comment Name="EdGraphNode_Comment_0"',
  '   NodePosX=700',
  '   NodePosY=700',
  '   NodeWidth=900',
  '   NodeHeight=600',
  '   NodeComment="Touch Inputs for First Person Character"',
  'End Object'
].join('\r\n');

test('蓝图解析：节点标题与 UE 一致、注释框、连接与方向检查', () => {
  const r = B.parse(T);
  assert.deepEqual(r.nodes.map(n => n.title), ['Event Secondary Thumbstick', 'DoLook', 'Touch Inputs for First Person Character']);
  assert.equal(r.nodes[2].comment, true);
  assert.deepEqual(r.nodes[2].size, {w: 900, h: 600});
  assert.equal(r.edges.length, 2);
  assert.deepEqual(r.issues, []);
  const bad = B.parse(T.replace('Direction="EGPD_Output",PinType.PinCategory="real"', 'PinType.PinCategory="real"'));
  assert.ok(bad.issues.some(i => /方向相同/.test(i.message)), '两端都是输入时报错');
  assert.throws(() => B.parse('随便一段文字'), /没有找到 UE 节点文本/);
});
