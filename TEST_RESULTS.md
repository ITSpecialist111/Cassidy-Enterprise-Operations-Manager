# Cassidy Testing Results - March 25, 2026

**Test Date:** March 25, 2026  
**Tester:** Graham (via integrated Teams)  
**Environment:** Production (ABSx02771022 tenant)  
**Agent Status:** ✅ Responding (with connector-specific limitations)

---

## Executive Summary

**Status:** ✅ **Core bot interaction restored after redeploy**

The previous `AuthorizationFailure` crash path has been fixed in production. Cassidy now responds to prompts again. One functional limitation remains in the Calendar connector path (Work IQ side), but this is now handled gracefully with a user-facing message rather than an exception.

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

---

## Conclusion

Cassidy is now operational in Teams for interactive demo flows. The major blocker (fatal AuthorizationFailure responses) is resolved in production. Remaining items are connector and background-memory quality improvements, not availability blockers.

---

**Report Updated:** March 25, 2026, 5:56 AM
