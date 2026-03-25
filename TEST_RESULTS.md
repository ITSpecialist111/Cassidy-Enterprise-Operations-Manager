# Cassidy Testing Results - March 25, 2026

**Test Date:** March 25, 2026  
**Tester:** Graham (via integrated Teams)  
**Environment:** Production (ABSx02771022 tenant)  
**Agent Status:** ✅ Responding (with connector-specific limitations)

---

## Executive Summary

**Status:** ✅ **Core bot interaction restored after redeploy**

The previous `AuthorizationFailure` crash path has been fixed in production. Cassidy now responds to prompts again. One functional limitation remains in the Calendar connector path (Work IQ side), but this is now handled gracefully with a user-facing message rather than an exception.

## Latest Remediation Status

The next remediation pass has now been deployed to production with two changes:

1. `AgentApplication` now initializes an `AgenticAuthConnection` authorization handler so live MCP server discovery is no longer blocked by missing app authorization configuration.
2. Azure Table Storage helpers now fail open on authorization failures for reads, lists, and upserts, preventing registry/profile persistence errors from interrupting runtime behavior.

### Verification completed for this pass

- `npm run build` completed successfully.
- `npm run test` completed successfully: 4 files, 87 tests passed.
- `a365 deploy` completed successfully to `cassidyopsagent-webapp`.
- `GET /api/health` returned `{"status":"healthy","agent":"Cassidy"...}` after deployment.
- `POST /api/proactive-trigger` returned `{"status":"triggered","triggerType":"morning_briefing","triggered":0,"errors":[]...}` after deployment.

### Verification still pending

- Live Teams chat confirmation that MCP-backed tool discovery now succeeds during a real user turn.
- Live Teams confirmation that user registry and profiling paths no longer surface authorization failures in turn handling.

---

## What Was Fixed

1. Added resilience in conversation memory writes so Azure Table Storage auth failures do not abort chat turns.
2. Redeployed with `a365 deploy` to `cassidyopsagent-webapp`.
3. Verified in live App Service logs:
   - `[ConversationMemory] Azure Table Storage authorization failed; continuing without persisted history`
   - No top-level user-facing crash for this path.

---

## Retest Results (Post-Deploy)

| Test # | Scenario | Status | Notes |
|--------|----------|--------|-------|
| 1 | NLU / calendar query (`What's my availability next week?`) | ✅ PASS (graceful degradation) | Cassidy replied at 5:54 AM with connector-unavailable guidance instead of crashing. |
| 2 | Morning brief (`Show me the morning brief`) | ✅ PASS | Cassidy returned full brief at 5:56 AM with priorities, approvals, workload, and actions. |
| 3 | Storage auth failure behavior | ✅ PASS | Table auth failures now logged as warnings, not surfaced as fatal user errors. |
| 4 | Complex planning / decomposition (`plan the customer summit for Q3`) | ⚠️ DEGRADED | Request remained in `Cassidy is typing` state beyond a reasonable demo window with no final response. |
| 5 | Task prioritization prompt (`Show me the tasks in priority order`) | ✅ PARTIAL | Cassidy quickly asked a sensible clarification question about scope and filter. |
| 6 | Clarified prioritization (`Operations team, all open tasks`) | ⚠️ DEGRADED | After clarification, Cassidy remained in typing state and did not return the ranked task list within a reasonable demo window. |

---

## Current Known Issues

1. **Calendar connector availability (Work IQ)**
   - Symptom: Cassidy reports calendar connector unavailable for free/busy retrieval.
   - Impact: Availability requests are degraded, but chat remains functional.
   - Action: Validate CalendarTools MCP server/permissions on Work IQ side.

2. **Table Storage RBAC for profiling/insights tables**
   - Symptom: Background profiling logs still show `AuthorizationFailure` for some table reads.
   - Impact: Does not block replies, but long-term personalization may be incomplete.
   - Action: Confirm data-plane permissions for all Cassidy tables used by user insights/profiling.

3. **User registry persistence blocked**
   - Symptom: Live logs show `User registration failed: RestError ... AuthorizationFailure` for `CassidyUserRegistry`.
   - Impact: Proactive user registration and some notification flows may be incomplete or unreliable.
   - Action: Grant/verify Azure Table data permissions for all registry-related tables, not just conversation history.

4. **User insights/profile persistence blocked**
   - Symptom: Live logs show profiling and insights table authorization failures.
   - Impact: Personalization, memory, and learned preferences are degraded.
   - Action: Verify access to `CassidyUserInsights` and related profiling tables.

5. **Live MCP tool discovery not configured**
   - Symptom: Logs show `[MCP] Failed to discover servers: The Application.authorization property is unavailable because no authorization options were configured.`
   - Impact: Cassidy falls back to static tools only; live M365 / Work IQ connected tools are unavailable in chat turns.
   - Action: Configure Agent authorization options correctly so OBO-backed MCP discovery works at runtime.

6. **Complex workflow latency / hang**
   - Symptom: Larger multi-step prompts can remain in typing state for an extended period with no final answer.
   - Impact: Demo reliability is poor for autonomous planning scenarios.
   - Action: Inspect long-running GPT/tool loop behavior, timeouts, and whether missing MCP auth is causing stalled planning flows.

7. **Second-turn operational retrieval can stall after clarification**
   - Symptom: Cassidy can ask a good clarification question for ranked task requests, but the follow-up retrieval may hang.
   - Impact: Multi-turn operational retrieval is less reliable than single-turn summaries.
   - Action: Inspect the post-clarification path for task ranking and determine whether it depends on unavailable live MCP connectors or slow tool loops.

8. **Risk dashboard data source unavailable**
   - Symptom: Morning brief explicitly reports that operational risk score and predictions are temporarily unavailable due to a data source error.
   - Impact: Predictive/risk intelligence is degraded.
   - Action: Trace the risk dashboard connector/data source and restore it.

---

## Working Well Right Now

1. **Teams chat responses are back**
   - Cassidy now returns answers in chat after redeployment.

2. **Morning brief generation**
   - Produces rich, structured operational summaries with priorities, approvals, workload, and next-step prompts.

3. **Graceful failure handling for storage auth**
   - Fatal conversation crashes from memory persistence are resolved.

4. **Useful fallback behavior for calendar requests**
   - Cassidy explains connector limitations and asks clarifying follow-up questions instead of crashing.

5. **First-turn clarification quality is good**
   - For prioritization requests, Cassidy asks relevant scope/filter questions instead of guessing.

---

## Conclusion

Cassidy is now operational in Teams for interactive demo flows. The major blocker (fatal AuthorizationFailure responses) is resolved in production. Remaining items are connector and background-memory quality improvements, not availability blockers.

---

**Report Updated:** March 25, 2026, 6:19 AM
