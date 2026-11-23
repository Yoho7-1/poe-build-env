-- Build editing through PoB's own classes. Loaded by pob-worker.lua after import.
-- Every failure is fatal (error) so no partial edit can be saved or calculated.
local M = {}

local function fail(fmt, ...) error('Change error: ' .. string.format(fmt, ...), 0) end
local function check(cond, fmt, ...) if not cond then fail(fmt, ...) end return cond end
local function lower(s) return tostring(s or ''):lower() end

local function allocSnapshot(spec)
  local ids = {}
  for id in pairs(spec.allocNodes) do ids[id] = true end
  return ids
end
local function nodeInfo(node)
  return { id = node.id, name = node.dn or node.name, type = node.type, ascendancy = node.ascendancyName }
end
local function diffAlloc(spec, before)
  local added, removed = {}, {}
  for id, node in pairs(spec.allocNodes) do if not before[id] then table.insert(added, nodeInfo(node)) end end
  for id in pairs(before) do if not spec.allocNodes[id] then table.insert(removed, nodeInfo(spec.nodes[id] or { id = id })) end end
  table.sort(added, function(a, b) return a.id < b.id end)
  table.sort(removed, function(a, b) return a.id < b.id end)
  return added, removed
end

-- Ascendancy identifiers: PoB uses internal ids (e.g. Raider = Warden). Accept name or id.
local function ascendancyNames(spec)
  local names = {}
  if spec.curAscendClass then
    if spec.curAscendClass.id then names[spec.curAscendClass.id] = true end
    if spec.curAscendClass.name then names[spec.curAscendClass.name] = true end
  end
  if spec.curSecondaryAscendClass then
    if spec.curSecondaryAscendClass.id then names[spec.curSecondaryAscendClass.id] = true end
    if spec.curSecondaryAscendClass.name then names[spec.curSecondaryAscendClass.name] = true end
  end
  return names
end

local function resolveNode(spec, ref, what)
  if type(ref) == 'number' then
    return check(spec.nodes[ref], 'Unknown %s node id %s in tree %s', what, tostring(ref), spec.treeVersion)
  end
  check(type(ref) == 'string' and ref ~= '', 'Node reference must be an id or a name')
  local allowedAsc, matches = ascendancyNames(spec), {}
  for id, node in pairs(spec.nodes) do
    local name = node.dn or node.name
    if (name == ref) and not node.isProxy and (not node.ascendancyName or allowedAsc[node.ascendancyName]) then
      table.insert(matches, node)
    end
  end
  check(#matches > 0, 'No %s node named "%s" (exact, case-sensitive; other ascendancies are excluded)', what, ref)
  if #matches > 1 then
    local ids = {}
    for _, n in ipairs(matches) do table.insert(ids, tostring(n.id)) end
    table.sort(ids)
    fail('Ambiguous %s node name "%s"; use one of the ids: %s', what, ref, table.concat(ids, ', '))
  end
  return matches[1]
end

local function asciiTitle(title, fallback)
  if title == nil then return fallback end
  check(type(title) == 'string' and title:match('^[\32-\126]+$') and #title <= 100, 'Set titles must be printable ASCII, 1-100 characters')
  return title
end

local function syncLoadouts()
  if build.SyncLoadouts then pcall(build.SyncLoadouts, build) end
end

function M.sets(list, report)
  report.sets = {}
  for index, op in ipairs(list) do
    check(op.type == 'tree' or op.type == 'item' or op.type == 'skill', 'sets[%d].type must be tree, item or skill', index)
    check(op.action == 'new' or op.action == 'copy', 'sets[%d].action must be new or copy', index)
    local entry = { type = op.type, action = op.action }
    if op.type == 'tree' then
      local treeTab = build.treeTab
      local newSpec
      if op.action == 'copy' then
        local from = op.from or treeTab.activeSpec
        local source = check(treeTab.specList[from], 'sets[%d]: unknown tree spec index %s', index, tostring(from))
        newSpec = new('PassiveSpec'):PassiveSpec(build, source.treeVersion)
        newSpec.title = source.title
        newSpec.jewels = copyTable(source.jewels)
        newSpec:RestoreUndoState(source:CreateUndoState())
        newSpec:BuildClusterJewelGraphs()
        entry.from = from
      else
        newSpec = new('PassiveSpec'):PassiveSpec(build, latestTreeVersion)
        newSpec:SelectClass(build.spec.curClassId)
        newSpec:SelectAscendClass(build.spec.curAscendClassId)
        newSpec:SelectSecondaryAscendClass(build.spec.curSecondaryAscendClassId or 0)
      end
      newSpec.title = asciiTitle(op.title, newSpec.title or 'Default')
      table.insert(treeTab.specList, newSpec)
      entry.id = #treeTab.specList
      entry.title = newSpec.title
      if op.activate then treeTab:SetActiveSpec(entry.id) end
    elseif op.type == 'item' then
      local itemsTab = build.itemsTab
      local newSet
      if op.action == 'copy' then
        local from = op.from or itemsTab.activeItemSetId
        local source = check(itemsTab.itemSets[from], 'sets[%d]: unknown item set id %s', index, tostring(from))
        newSet = copyTable(source)
        newSet.id = 1
        while itemsTab.itemSets[newSet.id] do newSet.id = newSet.id + 1 end
        itemsTab.itemSets[newSet.id] = newSet
        entry.from = from
      else
        newSet = itemsTab:NewItemSet()
      end
      newSet.title = asciiTitle(op.title, newSet.title)
      table.insert(itemsTab.itemSetOrderList, newSet.id)
      entry.id = newSet.id
      entry.title = newSet.title
      if op.activate then itemsTab:SetActiveItemSet(newSet.id) end
    else
      local skillsTab = build.skillsTab
      local newSet
      if op.action == 'copy' then
        local from = op.from or skillsTab.activeSkillSetId
        local source = check(skillsTab.skillSets[from], 'sets[%d]: unknown skill set id %s', index, tostring(from))
        newSet = copyTable(source, true)
        newSet.socketGroupList = {}
        for _, group in ipairs(source.socketGroupList) do
          local newGroup = copyTable(group, true)
          newGroup.gemList = {}
          for gemIndex, gem in ipairs(group.gemList) do newGroup.gemList[gemIndex] = copyTable(gem, true) end
          table.insert(newSet.socketGroupList, newGroup)
        end
        newSet.id = 1
        while skillsTab.skillSets[newSet.id] do newSet.id = newSet.id + 1 end
        skillsTab.skillSets[newSet.id] = newSet
        entry.from = from
      else
        newSet = skillsTab:NewSkillSet()
      end
      newSet.title = asciiTitle(op.title, newSet.title)
      table.insert(skillsTab.skillSetOrderList, newSet.id)
      entry.id = newSet.id
      entry.title = newSet.title
      if op.activate then skillsTab:SetActiveSkillSet(newSet.id) end
    end
    entry.active = op.activate and true or false
    table.insert(report.sets, entry)
  end
  syncLoadouts()
end

function M.tree(t, report)
  local spec = build.spec
  local r = { tree_spec = build.treeTab.activeSpec, allocated = {}, deallocated = {}, masteries = {} }
  report.tree = r
  if t.class ~= nil then
    local classId
    for id, class in pairs(spec.tree.classes) do if lower(class.name) == lower(t.class) then classId = id end end
    check(classId, 'Unknown class "%s"', tostring(t.class))
    local before = spec.curClassName
    if classId ~= spec.curClassId then
      check(spec:CountAllocNodes() == 0 or spec:IsClassConnected(classId), 'Class change to %s would reset the allocated tree; connect its start first or start a new tree set', t.class)
      local snap = allocSnapshot(spec)
      spec:SelectClass(classId)
      local added, removed = diffAlloc(spec, snap)
      local function nonStart(list) local out = {} for _, n in ipairs(list) do if n.type ~= "ClassStart" and n.type ~= "AscendClassStart" then table.insert(out, n) end end return out end
      r.class_side_effects = { added = nonStart(added), removed = nonStart(removed) }
    end
    r.class = { before = before, after = spec.curClassName }
  end
  if t.ascendancy ~= nil then
    local wanted, ascId = lower(t.ascendancy), nil
    if wanted == 'none' or wanted == '' then ascId = 0 else
      for id, asc in pairs(spec.curClass.classes) do
        if id ~= 0 and (lower(asc.name) == wanted or lower(asc.id) == wanted) then ascId = id end
      end
    end
    check(ascId, 'Ascendancy "%s" does not belong to %s', tostring(t.ascendancy), spec.curClassName)
    local before, snap = spec.curAscendClassName, allocSnapshot(spec)
    spec:SelectAscendClass(ascId)
    local _, removed = diffAlloc(spec, snap)
    r.ascendancy = { before = before, after = spec.curAscendClassName, internal_id = spec.curAscendClassBaseName, removed_nodes = removed }
  end
  if t.bloodline ~= nil then
    check(spec.tree.alternate_ascendancies, 'Tree %s has no bloodlines', spec.treeVersion)
    local wanted, altId = lower(t.bloodline), nil
    if wanted == 'none' or wanted == '' then altId = 0 else
      for id, alt in pairs(spec.tree.alternate_ascendancies) do
        if lower(alt.name) == wanted or lower(alt.id) == wanted then altId = id end
      end
    end
    check(altId, 'Unknown bloodline "%s"', tostring(t.bloodline))
    local before, snap = spec.curSecondaryAscendClassName or 'None', allocSnapshot(spec)
    spec:SelectSecondaryAscendClass(altId)
    local _, removed = diffAlloc(spec, snap)
    r.bloodline = { before = before, after = spec.curSecondaryAscendClassName or 'None', internal_id = spec.curSecondaryAscendClass and spec.curSecondaryAscendClass.id, removed_nodes = removed }
    if spec.curSecondaryAscendClass and spec.curSecondaryAscendClass.id == 'Brinerot' then
      r.warnings = r.warnings or {}
      table.insert(r.warnings, 'Velka Bloodline is unconfirmed for the 3.30 league; do not present it as available.')
    end
  end
  for _, ref in ipairs(t.deallocate or {}) do
    local node = resolveNode(spec, ref, 'deallocate')
    check(node.alloc, 'Node %d (%s) is not allocated', node.id, node.dn or node.name)
    check(node.type ~= 'ClassStart' and node.type ~= 'AscendClassStart', 'Start node %d cannot be deallocated', node.id)
    local snap = allocSnapshot(spec)
    spec:DeallocNode(node)
    local _, removed = diffAlloc(spec, snap)
    table.insert(r.deallocated, { requested = ref, node = nodeInfo(node), removed = removed })
  end
  for _, ref in ipairs(t.allocate or {}) do
    local node = resolveNode(spec, ref, 'allocate')
    check(not node.alloc, 'Node %d (%s) is already allocated', node.id, node.dn or node.name)
    check(node.type ~= 'Mastery', 'Node %d is a mastery; use tree.masteries with an effect', node.id)
    check(node.path, 'Node %d (%s) has no path from the allocated tree (other ascendancy, cluster without jewel or unreachable)', node.id, node.dn or node.name)
    local snap = allocSnapshot(spec)
    spec:AllocNode(node)
    check(node.alloc, 'PoB did not allocate node %d (%s)', node.id, node.dn or node.name)
    local added = diffAlloc(spec, snap)
    table.insert(r.allocated, { requested = ref, node = nodeInfo(node), path = added, points = #added })
  end
  for index, m in ipairs(t.masteries or {}) do
    local node = resolveNode(spec, m.node, 'mastery')
    check(node.type == 'Mastery', 'masteries[%d]: node %d is not a mastery', index, node.id)
    local chosen
    for _, option in ipairs(node.masteryEffects or {}) do
      local text = table.concat(option.stats or {}, ' / ')
      if (type(m.effect) == 'number' and option.effect == m.effect) or (type(m.effect) == 'string' and text == m.effect) then chosen = option end
    end
    if not chosen and type(m.effect) == 'string' then
      local hits = {}
      for _, option in ipairs(node.masteryEffects or {}) do
        if table.concat(option.stats or {}, ' / '):find(m.effect, 1, true) then table.insert(hits, option) end
      end
      check(#hits < 2, 'masteries[%d]: effect text "%s" matches several options of node %d; use the effect id', index, m.effect, node.id)
      chosen = hits[1]
    end
    if not chosen then
      local options = {}
      for _, option in ipairs(node.masteryEffects or {}) do table.insert(options, option.effect .. '=' .. table.concat(option.stats or {}, ' / ')) end
      fail('masteries[%d]: effect %s is not an option of %s (%d): %s', index, tostring(m.effect), node.dn or node.name, node.id, table.concat(options, ' | '))
    end
    local owner = isValueInTable(spec.masterySelections, chosen.effect)
    check(not owner or owner == node.id, 'masteries[%d]: effect %d is already selected on mastery %s', index, chosen.effect, tostring(owner))
    local effect = check(spec.tree.masteryEffects[chosen.effect], 'Unknown mastery effect %d', chosen.effect)
    local previous = spec.masterySelections[node.id]
    local snap = allocSnapshot(spec)
    if not node.alloc then check(node.path, 'Mastery %d has no path from the allocated tree', node.id) end
    node.sd = effect.sd
    node.allMasteryOptions = false
    node.reminderText = { 'Tip: Right click to select a different effect' }
    spec.tree:ProcessStats(node)
    spec.masterySelections[node.id] = effect.id
    if not node.alloc then spec:AllocNode(node) else spec:BuildAllDependsAndPaths() end
    check(node.alloc, 'PoB did not allocate mastery %d', node.id)
    local added = diffAlloc(spec, snap)
    table.insert(r.masteries, { node = nodeInfo(node), effect = effect.id, stats = effect.sd, previous_effect = previous, path = added })
  end
end

function M.jewels(list, report)
  report.jewels = {}
  local itemsTab = build.itemsTab
  for index, change in ipairs(list) do
    local spec = build.spec
    check(type(change.node) == 'number', 'jewels[%d].node must be a socket node id', index)
    local slot = check(itemsTab.sockets[change.node], 'jewels[%d]: node %d is not a jewel socket', index, change.node)
    check(spec.allocNodes[change.node], 'jewels[%d]: socket %d is not allocated; add it to tree.allocate first', index, change.node)
    itemsTab:CreateDisplayItemFromRaw(change.text)
    local item = check(itemsTab.displayItem, 'jewels[%d]: item text could not be parsed', index)
    check(item.type == 'Jewel', 'jewels[%d]: item is not a jewel (%s)', index, tostring(item.type))
    check(itemsTab:IsItemValidForSlot(item, slot.slotName), 'jewels[%d]: %s is not valid for socket %d', index, item.name, change.node)
    local replaced = spec.jewels[change.node]
    itemsTab:AddDisplayItem(true)
    slot:SetSelItemId(item.id)
    spec.jewels[change.node] = item.id
    spec:BuildClusterJewelGraphs()
    itemsTab:PopulateSlots()
    local entry = { node = change.node, item_id = item.id, name = item.name, base = item.baseName, cluster = item.clusterJewel ~= nil, replaced_item_id = (replaced and replaced ~= 0) and replaced or nil }
    if change.allocate then
      local sub = { allocate = change.allocate }
      local subReport = {}
      M.tree(sub, subReport)
      entry.allocated = subReport.tree.allocated
    end
    table.insert(report.jewels, entry)
  end
end

local function makeGem(spec, index, where)
  check(type(spec.name) == 'string' and spec.name ~= '', '%s gems[%d].name is required', where, index)
  local err, gemData = build.skillsTab:FindSkillGem(spec.name)
  check(gemData and not err, '%s gems[%d]: %s', where, index, err or ('Unknown gem ' .. spec.name))
  check(lower(gemData.name) == lower(spec.name), '%s gems[%d]: "%s" is not an exact gem name (closest: %s)', where, index, spec.name, gemData.name)
  check(not gemData.grantedEffect.unsupported, '%s gems[%d]: %s is not supported by PoB', where, index, gemData.name)
  return {
    nameSpec = gemData.name, gemId = gemData.id, skillId = gemData.grantedEffectId,
    level = spec.level or gemData.naturalMaxLevel or 20, quality = spec.quality or 0,
    enabled = spec.enabled ~= false, enableGlobal1 = true, enableGlobal2 = true, count = 1,
  }
end
local function gemReport(gem)
  return { id = gem.gemId, name = gem.nameSpec, level = gem.level, quality = gem.quality, enabled = gem.enabled, support = gem.gemData and gem.gemData.grantedEffect.support or false }
end
local function processGroup(group, where)
  build.skillsTab:ProcessSocketGroup(group)
  for i, gem in ipairs(group.gemList) do
    check(gem.gemData and not gem.errMsg, '%s gem %d (%s): %s', where, i, tostring(gem.nameSpec), tostring(gem.errMsg or 'not recognised'))
  end
end
local function hasActive(group)
  for _, gem in ipairs(group.gemList) do if gem.gemData and not gem.gemData.grantedEffect.support then return true end end
  return false
end

function M.skills(s, report)
  local skillsTab = build.skillsTab
  local list = skillsTab.socketGroupList
  local r = { skill_set = skillsTab.activeSkillSetId, modified = {}, removed = {}, added = {} }
  report.skills = r
  for index, g in ipairs(s.groups or {}) do
    local where = string.format('skills.groups[%d]', index)
    local group = check(list[g.group], '%s: unknown socket group %s', where, tostring(g.group))
    check(not group.source, '%s: group %d is granted by an item and cannot be edited', where, g.group)
    local entry = { group = g.group, removed_gems = {}, added_gems = {}, replaced_gems = {} }
    for _, rg in ipairs(g.replace_gems or {}) do
      local old = check(group.gemList[rg.gem], '%s: unknown gem index %s', where, tostring(rg.gem))
      local gem = makeGem(rg, rg.gem, where)
      if rg.level == nil then gem.level = old.level end
      if rg.quality == nil then gem.quality = old.quality end
      group.gemList[rg.gem] = gem
      table.insert(entry.replaced_gems, { gem = rg.gem, before = gemReport(old), after_name = gem.nameSpec })
    end
    local removeIdx = {}
    for _, i in ipairs(g.remove_gems or {}) do check(group.gemList[i], '%s: unknown gem index %s', where, tostring(i)); table.insert(removeIdx, i) end
    table.sort(removeIdx, function(a, b) return a > b end)
    for k = 2, #removeIdx do check(removeIdx[k] ~= removeIdx[k - 1], '%s: duplicate remove_gems index', where) end
    for _, i in ipairs(removeIdx) do table.insert(entry.removed_gems, gemReport(group.gemList[i])); table.remove(group.gemList, i) end
    for i, gs in ipairs(g.add_gems or {}) do table.insert(group.gemList, makeGem(gs, i, where)) end
    if g.label ~= nil then group.label = asciiTitle(g.label, '') end
    if g.slot ~= nil then group.slot = g.slot ~= '' and g.slot or nil end
    if g.enabled ~= nil then group.enabled = g.enabled end
    if g.include_in_full_dps ~= nil then group.includeInFullDPS = g.include_in_full_dps end
    check(#group.gemList > 0, '%s: group would be empty; remove the group instead', where)
    processGroup(group, where)
    entry.gems = {}
    for _, gem in ipairs(group.gemList) do table.insert(entry.gems, gemReport(gem)) end
    entry.include_in_full_dps = group.includeInFullDPS and true or false
    entry.enabled = group.enabled
    table.insert(r.modified, entry)
  end
  local removeGroups = {}
  for _, i in ipairs(s.remove_groups or {}) do
    local group = check(list[i], 'skills.remove_groups: unknown socket group %s', tostring(i))
    check(not group.source, 'skills.remove_groups: group %d is granted by an item', i)
    table.insert(removeGroups, i)
  end
  table.sort(removeGroups, function(a, b) return a > b end)
  for k = 2, #removeGroups do check(removeGroups[k] ~= removeGroups[k - 1], 'skills.remove_groups: duplicate index') end
  for _, i in ipairs(removeGroups) do
    local group = list[i]
    local gems = {}
    for _, gem in ipairs(group.gemList) do table.insert(gems, gemReport(gem)) end
    table.insert(r.removed, { group = i, label = group.label, gems = gems })
    table.remove(list, i)
    if build.mainSocketGroup == i then build.mainSocketGroup = 1; r.main_socket_group_reset = true
    elseif build.mainSocketGroup > i then build.mainSocketGroup = build.mainSocketGroup - 1 end
    local calcIndex = build.calcsTab.input.skill_number
    if calcIndex and calcIndex > i then build.calcsTab.input.skill_number = calcIndex - 1 end
  end
  for index, g in ipairs(s.add_groups or {}) do
    local where = string.format('skills.add_groups[%d]', index)
    check(type(g.gems) == 'table' and #g.gems > 0, '%s: gems are required', where)
    local group = { label = asciiTitle(g.label, ''), slot = g.slot, enabled = g.enabled ~= false, includeInFullDPS = g.include_in_full_dps and true or nil,
      mainActiveSkill = 1, mainActiveSkillCalcs = 1, gemList = {} }
    for i, gs in ipairs(g.gems) do table.insert(group.gemList, makeGem(gs, i, where)) end
    processGroup(group, where)
    table.insert(list, group)
    local entry = { group = #list, label = group.label, slot = group.slot, gems = {}, include_in_full_dps = group.includeInFullDPS and true or false, has_active_skill = hasActive(group) }
    for _, gem in ipairs(group.gemList) do table.insert(entry.gems, gemReport(gem)) end
    if g.main then
      check(entry.has_active_skill, '%s: a main socket group needs an active skill gem', where)
      build.mainSocketGroup = #list
      entry.main = true
    end
    table.insert(r.added, entry)
  end
  if build.mainSocketGroup > #list then build.mainSocketGroup = math.max(1, #list) end
  r.main_socket_group = build.mainSocketGroup
  build.buildFlag = true
end

-- Applied after calculation so PoB's ExtraPoints output is known.
function M.budget(options)
  local used, asc, bloodline = build.spec:CountAllocNodes()
  local extra = build.calcsTab.mainOutput and build.calcsTab.mainOutput.ExtraPoints or 0
  local quest = options.quest_points or 23
  local passive = math.max(0, build.characterLevel - 1) + quest + extra
  local ascMax = options.ascendancy_points or 8
  local result = { passive_used = used, passive_available = passive, quest_points_assumed = quest, extra_points = extra,
    ascendancy_used = asc, ascendancy_available = ascMax, bloodline_subset = bloodline,
    note = 'Bloodline points are a subset of ascendancy_used and share its budget.' }
  local disconnected = {}
  for id, node in pairs(build.spec.allocNodes) do
    if node.type ~= 'ClassStart' and node.type ~= 'AscendClassStart' and not node.connectedToStart and #(node.intuitiveLeapLikesAffecting or {}) == 0 then
      table.insert(disconnected, nodeInfo(node))
    end
  end
  result.disconnected_nodes = disconnected
  return result
end

return M
