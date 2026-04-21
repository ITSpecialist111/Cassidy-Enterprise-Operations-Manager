// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// CorpGen public surface
// ---------------------------------------------------------------------------

export * from './types';
export {
  defaultCassidyIdentity,
  loadIdentity,
  saveIdentity,
  jitteredWorkday,
  identitySystemBlock,
} from './identity';
export {
  generateMonthlyPlan,
  generateDailyPlan,
  loadMonthlyPlan,
  loadDailyPlan,
  saveDailyPlan,
  listDailyPlans,
  selectNextTask,
  updateTaskStatus,
  isPlanComplete,
  propagateTaskChange,
} from './hierarchicalPlanner';
export {
  recordStructured,
  listStructured,
  retrieveForCycle,
  renderRetrievedContext,
  workingGet,
  workingSet,
  workingReset,
  DEFAULT_RETRIEVAL,
} from './tieredMemory';
export {
  compressIfNeeded,
  classifyTurn,
  estimateTokens,
  turnsTokens,
  DEFAULT_SUMMARISE,
} from './adaptiveSummarizer';
export {
  COGNITIVE_TOOL_DEFS,
  COGNITIVE_HANDLERS,
  cg_generate_plan,
  cg_update_plan,
  cg_track_task,
  cg_list_open_tasks,
  cg_reflect,
} from './cognitiveTools';
export {
  SUBAGENT_TOOL_DEFS,
  SUBAGENT_HANDLERS,
  runResearchAgent,
  runComputerUseSubAgent,
  registerCuaProvider,
} from './subAgents';
export type {
  ResearchRequest,
  ResearchReport,
  ResearchDepth,
  CuaRequest,
  CuaResult,
  CuaProvider,
} from './subAgents';
export {
  captureSuccessfulTrajectory,
  retrieveSimilarTrajectories,
  markDemoReused,
} from './experientialLearning';
export {
  runWorkday,
  runMultiDay,
  runOrganization,
} from './digitalEmployee';
export type {
  ToolExecutor,
  RunOptions,
  MultiDayOptions,
  OrganizationOptions,
  OrganizationMember,
  OrganizationResult,
} from './digitalEmployee';
export {
  withCommFallback,
  DEFAULT_COMM_FALLBACKS,
} from './commFallback';
export type {
  FallbackMap,
  FallbackOptions,
  ArgRewriter,
} from './commFallback';
export {
  recordArtifact,
  listArtifacts,
  judgeTask,
  judgeDay,
} from './artifactJudge';
export type {
  JudgeOptions,
  DayJudgement,
} from './artifactJudge';
export {
  runAgent,
  assembleToolList,
} from './agentHarness';
export {
  getAppIndex,
  rebuildAppIndex,
  clearAllIndices,
} from './faissIndex';
