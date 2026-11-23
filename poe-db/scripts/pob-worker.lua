-- Executed by the pinned LuaJIT runtime inside vendor/pob/src.
package.path = '../runtime/lua/?.lua;../runtime/lua/?/init.lua;./?.lua;' .. package.path
package.cpath = '../runtime/?.dll;' .. package.cpath
arg = {}
local json = require('dkjson')
local function read(file) local f=assert(io.open(file,'rb')); local s=f:read('*a'); f:close(); return s end
local function write(file,text) local f=assert(io.open(file,'wb')); f:write(text); f:close() end
local request = assert(json.decode(read(AGENT_REQUEST)))
-- Network and updates are deliberately unavailable in this local calculator.
local oldRead = io.read
io.read = function() error('Interactive PoB prompt: ' .. tostring(__mainObject__ and __mainObject__.promptMsg)) end
dofile('HeadlessWrapper.lua')
dofile(request.runtime_helpers)
io.read = oldRead
local edit = dofile(request.edit_helpers)
if request.xml then
  loadBuildFromXML(read(request.xml), 'Local agent calculation')
elseif request.new_build then
  newBuild()
else
  newBuild()
  build.characterLevel = 90
  build.characterLevelAutoMode = false
  build.skillsTab:PasteSocketGroup('Fireball 20/0  1\n')
end
local function assertHealthy(stage)
  assert(not __mainObject__.promptMsg,'PoB engine error during '..stage..': '..tostring(__mainObject__.promptMsg))
end
assertHealthy('build import')
if request.expected_tree_specs then assert(#build.treeTab.specList==request.expected_tree_specs,'PoB loaded only '..#build.treeTab.specList..' of '..request.expected_tree_specs..' tree specs; partial import is not a valid calculation') end
if request.selection then
  local s=request.selection
  if s.tree_spec then assert(build.treeTab.specList[s.tree_spec],'Unknown tree spec');build.treeTab:SetActiveSpec(s.tree_spec) end
  if s.item_set then assert(build.itemsTab.itemSets[s.item_set],'Unknown item set');build.itemsTab:SetActiveItemSet(s.item_set) end
  if s.skill_set then assert(build.skillsTab.skillSets[s.skill_set],'Unknown skill set');build.skillsTab:SetActiveSkillSet(s.skill_set) end
  if s.character_level then build.characterLevelAutoMode=false;build.characterLevel=s.character_level;build.controls.characterLevel:SetText(s.character_level) end
  if s.main_socket_group then assert(build.skillsTab.socketGroupList[s.main_socket_group],'Unknown main socket group');build.mainSocketGroup=s.main_socket_group end
end
local migration
if request.migrate_to then
  assert(request.migrate_to=='3_30','Only explicit standard 3_30 migration is supported')
  local oldTrees={}
  for i,spec in ipairs(build.treeTab.specList) do
    local nodes={}
    for id,node in pairs(spec.allocNodes) do nodes[tostring(id)]={name=node.name,stats=node.stats or {}} end
    oldTrees[i]={version=spec.treeVersion,title=spec.title,nodes=nodes}
  end
  build.treeTab:ConvertAllToVersion('3_30')
  migration={target='3_30',method='PoB TreeTab:ConvertAllToVersion; originals retained outside the working copy',trees={}}
  for i,spec in ipairs(build.treeTab.specList) do
    local old,newNodes,removed,added,changed=assert(oldTrees[i]),{},{},{},{}
    for id,node in pairs(spec.allocNodes) do newNodes[tostring(id)]=node end
    for id,node in pairs(old.nodes) do
      local after=newNodes[id]
      if not after then table.insert(removed,{id=id,name=node.name})
      elseif node.name~=after.name or json.encode(node.stats)~=json.encode(after.stats or {}) then
        table.insert(changed,{id=id,before_name=node.name,after_name=after.name,before_stats=node.stats,after_stats=after.stats})
      end
    end
    for id,node in pairs(newNodes) do if not old.nodes[id] then table.insert(added,{id=id,name=node.name}) end end
    table.insert(migration.trees,{index=i,title=old.title,before_version=old.version,after_version=spec.treeVersion,removed=removed,added=added,changed=changed})
  end
end
local editReport = {}
if request.sets then edit.sets(request.sets, editReport) end
if request.tree then edit.tree(request.tree, editReport) end
if request.jewels then edit.jewels(request.jewels, editReport) end
if request.skills then edit.skills(request.skills, editReport) end
if request.config then for key,value in pairs(request.config) do
  assert(build.configTab.varControls[key], 'Unknown configuration option: ' .. key)
  build.configTab.input[key] = value
  -- Some apply functions read the drop-down selection (enemyIsBoss for boss presets, multiplierMapModTier for map
  -- mods) instead of the input value; keep the control in sync so a scripted value matches what the GUI would do.
  local control = build.configTab.varControls[key]
  if control._className == 'DropDownControl' then
    control:SelByValue(value, 'val')
    assert(control.list[control.selIndex] and control.list[control.selIndex].val == value, 'Unknown value for configuration option ' .. key .. ': ' .. tostring(value))
  end
end end
if request.custom_mods then
  local current = build.configTab.input.customMods or ''
  build.configTab.input.customMods = current .. '\n' .. request.custom_mods
end
if request.enemy_mods then
  -- Enemy-side modifiers in PoB's own mod vocabulary (the same calls the map affix apply functions make).
  -- Appended after every BuildModList so a rebuild during calculation cannot drop them.
  local originalBuild = build.configTab.BuildModList
  build.configTab.BuildModList = function(tab, ...)
    local r = originalBuild(tab, ...)
    for _,m in ipairs(request.enemy_mods) do
      local tags = {}
      if m.condition then table.insert(tags, { type = 'Condition', var = m.condition }) end
      tab.enemyModList:NewMod(m.name, m.type, m.value, m.source or 'Agent enemy mod', unpack(tags))
    end
    return r
  end
end
if request.add_support then
  local group = build.skillsTab.socketGroupList[build.mainSocketGroup or 1]
  assert(group, 'No main socket group')
  local oldGroupCount = #build.skillsTab.socketGroupList
  build.skillsTab:PasteSocketGroup(request.add_support .. ' 20/0  1\n')
  local added = build.skillsTab.socketGroupList[#build.skillsTab.socketGroupList]
  assert(#build.skillsTab.socketGroupList > oldGroupCount and added and added.gemList[1], 'Support import failed')
  table.insert(group.gemList, added.gemList[1])
  table.remove(build.skillsTab.socketGroupList)
end
if request.gem_levels then
  for _,change in ipairs(request.gem_levels) do
    local group = assert(build.skillsTab.socketGroupList[change.group], 'Unknown socket group')
    local gem = assert(group.gemList[change.gem], 'Unknown gem index')
    if change.level then gem.level = change.level end
    if change.quality then gem.quality = change.quality end
  end
end
if request.replace_items then
  for _,change in ipairs(request.replace_items) do
    local slot = assert(build.itemsTab.slots[change.slot], 'Unknown item slot')
    build.itemsTab:CreateDisplayItemFromRaw(change.text)
    local item = assert(build.itemsTab.displayItem, 'Item parse failed')
    assert(build.itemsTab:IsItemValidForSlot(item,change.slot), 'Invalid item for requested slot')
    build.itemsTab:AddDisplayItem(true)
    slot:SetSelItemId(item.id)
    build.itemsTab:PopulateSlots()
  end
end
build.configTab:BuildModList()
build.buildFlag = true
for i=1,3 do runCallback('OnFrame') end
assertHealthy('calculation')
local output = {}
for key,value in pairs(build.calcsTab.mainOutput) do
  if type(value)=='number' and value==value and value~=math.huge and value~=-math.huge then output[key]=value end
end
local groups = {}
for i,group in ipairs(build.skillsTab.socketGroupList) do
  local gems = {}
  for _,gem in ipairs(group.gemList) do table.insert(gems,{id=gem.gemId,name=gem.nameSpec,level=gem.level,quality=gem.quality,enabled=gem.enabled}) end
  table.insert(groups,{index=i,label=group.label,enabled=group.enabled,slot=group.slot,include_in_full_dps=group.includeInFullDPS and true or false,source=group.source,gems=gems})
end
local result = {output=output,config=build.configTab.input,groups=groups,main_socket_group=build.mainSocketGroup,
  class=build.spec.curClassName,ascendancy=build.spec.curAscendClassName,level=build.characterLevel,tree_version=build.spec.treeVersion,migration=migration}
local passivePoints,ascendancyPoints,secondaryAscendancyPoints=build.spec:CountAllocNodes()
result.allocated_points={passive=passivePoints,ascendancy_total=ascendancyPoints,bloodline_subset=secondaryAscendancyPoints}
result.budget=edit.budget(request.tree or {})
result.edit_report=editReport
if request.tree or request.jewels then
  local b=result.budget
  assert(#b.disconnected_nodes==0,'Change error: '..#b.disconnected_nodes..' allocated nodes are not connected to the class start')
  if not (request.tree and request.tree.allow_over_budget) then
    assert(b.passive_used<=b.passive_available,'Change error: passive budget exceeded: '..b.passive_used..' used, '..b.passive_available..' available at level '..build.characterLevel..' (quest_points '..b.quest_points_assumed..')')
    assert(b.ascendancy_used<=b.ascendancy_available,'Change error: ascendancy budget exceeded: '..b.ascendancy_used..' used (bloodline '..b.bloodline_subset..'), '..b.ascendancy_available..' available')
  end
end
result.tree_specs={}
for i,spec in ipairs(build.treeTab.specList) do table.insert(result.tree_specs,{index=i,title=spec.title or 'Default',version=spec.treeVersion}) end
result.item_sets={}
for _,id in ipairs(build.itemsTab.itemSetOrderList) do table.insert(result.item_sets,{id=id,title=build.itemsTab.itemSets[id].title or 'Default'}) end
result.skill_sets={}
for _,id in ipairs(build.skillsTab.skillSetOrderList) do table.insert(result.skill_sets,{id=id,title=build.skillsTab.skillSets[id].title or 'Default'}) end
result.selection={tree_spec=build.treeTab.activeSpec,item_set=build.itemsTab.activeItemSetId,skill_set=build.skillsTab.activeSkillSetId,character_level=build.characterLevel,main_socket_group=build.mainSocketGroup}
result.engine_warnings=build.controls.warnings and build.controls.warnings.lines or {}
result.applied_supports={}
local mainSkill=build.calcsTab.mainEnv and build.calcsTab.mainEnv.player.mainSkill
if mainSkill then
  result.skill_disabled_reason=mainSkill.disableReason
  for _,effect in ipairs(mainSkill.effectList or {}) do
    if effect.grantedEffect.support then table.insert(result.applied_supports,{id=effect.grantedEffect.id,name=effect.grantedEffect.name,level=effect.level,quality=effect.quality}) end
  end
end
-- On-kill explosion sources (Profane Bloom, item mods): raw ExplodeMod entries, unevaluated conditions included,
-- so the analysis can scale them by the encounter enemy's life (PoB uses monsterLifeTable[enemyLevel]).
result.explode_mods={}
do
  local seen={}
  local db=build.calcsTab.mainEnv and build.calcsTab.mainEnv.player and build.calcsTab.mainEnv.player.modDB
  while db do
    for _,m in ipairs(db.mods and db.mods.ExplodeMod or {}) do
      local v=m.value or {}
      local conditions={}
      for _,tag in ipairs(m) do if tag.var then table.insert(conditions,(tag.actor and (tag.actor..':') or '')..tag.var) end end
      local key=tostring(m.source)..'|'..tostring(v.type)..'|'..tostring(v.amount)..'|'..tostring(v.chance)
      if not seen[key] then seen[key]=true; local nodeId=tonumber(tostring(m.source):match('^Tree:(%d+)'))
        local node=nodeId and build.spec.nodes[nodeId]
        table.insert(result.explode_mods,{source=m.source,source_name=node and node.dn or nil,type=v.type,amount=v.amount,chance=v.chance,conditions=conditions}) end
    end
    db=db.parent
  end
end
local minion=build.calcsTab.mainEnv and build.calcsTab.mainEnv.minion
if minion and minion.output then
  result.minion_output={}
  for key,value in pairs(minion.output) do if type(value)=='number' and value==value and value~=math.huge and value~=-math.huge then result.minion_output[key]=value end end
end
result.unparsed_item_modifiers = {}
result.equipped_items = {}
for slotName,slot in pairs(build.itemsTab.slots) do
  if slot.selItemId and slot.selItemId ~= 0 and not slot.inactive then
    local item = build.itemsTab.items[slot.selItemId]
    if item then
      table.insert(result.equipped_items,{slot=slotName,id=item.id,name=item.name,base=item.baseName,rarity=item.rarity,item_level=item.itemLevel,active=slot.active})
      for _,key in ipairs({'explicitModLines','implicitModLines','enchantModLines','scourgeModLines','crucibleModLines'}) do
        for _,line in ipairs(item[key] or {}) do
          if line.extra then table.insert(result.unparsed_item_modifiers,{slot=slotName,line=line.line,unparsed=line.extra}) end
        end
      end
    end
  end
end
-- Custom modifier lines that PoB cannot parse are dropped silently by BuildModList; report them.
result.unparsed_custom_mods = {}
if request.custom_mods then
  for line in request.custom_mods:gmatch('([^\n]*)\n?') do
    local stripped = StripEscapes(line):match('^%s*(.-)%s*$')
    if stripped ~= '' then
      local mods, extra = modLib.parseMod(stripped)
      if not mods or extra then table.insert(result.unparsed_custom_mods,{line=stripped,unparsed=extra or stripped}) end
    end
  end
end
write(request.result,json.encode(result))
if request.save_xml then write(request.save_xml,build:SaveDB('code')) end
