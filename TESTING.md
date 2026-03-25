# Cassidy Testing & Demo Guide

A comprehensive walkthrough of Cassidy's capabilities with clear test scenarios, expected behaviors, and demo talking points.

## Quick Start: Invoking Cassidy

### In Teams
1. **1:1 Chat** — Open a direct message with Cassidy
   - Type any question or command
   - Cassidy will respond in the same thread

2. **Channel** — @ mention Cassidy in any channel
   - `@Cassidy Can you break down the Q2 roadmap?`
   - Response will appear as a threaded reply visible to all

3. **Scheduled Tasks** — Daily standup trigger (configured in Logic App)
   - Default: 8 AM local time
   - Collects updates from team
   - Posts summary to OPS_TEAMS_CHANNEL_ID

---

## Test Suite

### Test 1: Basic NLU & Context Awareness
**Objective:** Verify Cassidy understands natural language and maintains conversation context

**Test Steps:**
1. Send: `What's my availability next week?`
   - **Expected:** Cassidy queries your calendar via Microsoft Graph
   - **Check:** Response includes specific day/time slots from Outlook
   - **Demo talking point:** "Cassidy understands natural queries without formalized commands"

2. Follow-up: `Can you find 30 minutes for a sync with Sarah?`
   - **Expected:** Cassidy references "next week" from previous message
   - **Check:** Response mentions Sarah by name, suggests specific time slots
   - **Demo talking point:** "Context carries forward within the conversation"

3. Send: `Who owns the authentication module?`
   - **Expected:** Cassidy queries org graph (team structure)
   - **Check:** Responds with person, title, and team assignment
   - **Demo talking point:** "Cassidy has deep org knowledge"

---

### Test 2: Task Decomposition & Work Queue
**Objective:** Verify goal breakdown into actionable subtasks

**Test Steps:**
1. Send: `I need to plan the customer summit for Q3. Include venue search, sponsor outreach, and schedule logistics. Give me a timeline.`
   - **Expected:** Cassidy decomposes into 5-8 ordered subtasks
   - **Check:** Response shows:
     - Task sequence with dependencies (e.g., "Finalize date BEFORE venue search")
     - Suggested owner/tool for each (sendEmail, createTask, etc.)
     - Estimated effort or timeline
   - **Demo talking point:** "Complex goals become actionable work"

2. Follow-up: `Start working on this`
   - **Expected:** Cassidy queues tasks and begins autonomous execution
   - **Check:** 
     - Cassidy posts status update to OPS channel (if configured)
     - Starts on feasible tasks (e.g., creates Planner tasks, sends emails)
     - Waits/skips tasks requiring human approval
   - **Demo talking point:** "Cassidy executes autonomously without waiting"

3. Check Planner or your task list after 30 seconds:
   - **Expected:** New tasks appear with Cassidy as creator
   - **Check:** Tasks have descriptions and due dates
   - **Demo talking point:** "Work automatically appears in existing tools (Planner, email)"

---

### Test 3: Meeting Intelligence
**Objective:** Verify meeting transcription analysis and action item extraction

**Prerequisites:**
- Enable Microsoft Graph `OnlineMeetingTranscript.Read.All` scope
- Cassidy attending the Teams meeting

**Test Steps:**
1. **During a Teams meeting:**
   ```
   Attendee 1: "John, can you fix the API timeout issue by Friday?"
   Attendee 2: "Sure, I'll get that to you by EOD Thursday"
   Attendee 3: "Also, we need to update the deployment docs. @Cassidy can you help draft that?"
   ```

2. **Cassidy observes the meeting:**
   - **Expected:** Cassidy identifies action items and stakeholders
   - **Check:** After meeting, Cassidy messages you with:
     - Extracted action items (e.g., "John: Fix API timeout by Friday EOD Thu")
     - Who was mentioned in directives
     - Summary of key topics discussed

3. **Action Item Follow-up** (next day):
   - **Expected:** Proactive reminder about John's task (if deadline approaching)
   - **Check:** Cassidy sends Teams notification or email reminder
   - **Demo talking point:** "Cassidy provides meeting intelligence without manual note-taking"

---

### Test 4: Proactive Notifications & Escalation
**Objective:** Verify proactive message delivery based on events

**Test Steps:**
1. **Create an overdue task:**
   - Add a task in Planner with due date = yesterday
   - Wait 5 minutes

2. **Expected Behavior:**
   - **During work hours:** Cassidy sends Teams message: "Hey, task 'X' is overdue. Need help?"
   - **After hours:** No message (quiet hours enforcement)
   - **Check:** Message appears in your 1:1 with Cassidy

3. **Pending Approval Escalation:**
   - Send: `I'm waiting on finance to approve the software budget. It's been 3 days.`
   - **Expected:** Cassidy offers to:
     - Send follow-up message to finance
     - Escalate to your manager
   - **Check:** Message includes the specific approval item and context
   - **Demo talking point:** "Cassidy proactively escalates when things stall"

4. **Voice Escalation** (optional, high-urgency test):
   - Following a critical overdue item + no response in 30 mins
   - **Expected:** Cassidy attempts outbound calling (Teams call)
   - **Check:** Your Teams phone receives incoming call from Cassidy
   - **Demo talking point:** "Mission-critical alerts trigger voice notifications"

---

### Test 5: Report Generation
**Objective:** Verify automated report creation and distribution

**Test Steps:**
1. Send: `Generate a weekly team status report and send it to [manager@org].`
   - **Expected:** Report generation starts immediately
   - **Check:** Report includes:
     - Overdue tasks (with owners, due dates)
     - Team workload summary (# active tasks per person)
     - Pending approvals
     - Key completion milestones this week
     - Formatted as Teams message + email
   - **Demo talking point:** "One command generates executive summaries"

2. Check manager's email:
   - **Expected:** Email with report content
   - **Check:** Includes formatted table or bullet points (not raw data)
   - **Demo talking point:** "Reports integrate with key tools (email, Teams, SharePoint)"

3. Send: `Add a custom section about project risks to next week's report`
   - **Expected:** Cassidy confirms and updates report template
   - **Check:** Next week's report includes a "Risk Summary" section
   - **Demo talking point:** "Reports are customizable per org needs"

---

### Test 6: Memory & Personal Context
**Objective:** Verify Cassidy learns and retains user preferences

**Test Steps:**
1. Send: `I work best in the mornings. Don't schedule meetings after 4 PM.`
   - **Expected:** Cassidy acknowledges preference
   - **Check:** Cassidy confirms: "Got it, I'll avoid calendar blocks after 4 PM"

2. Later (1+ week), send: `Find time for a meeting with the team`
   - **Expected:** Cassidy respects the stored preference
   - **Check:** All suggested slots are:
     - Before 4 PM
     - Not conflicting with your morning routine
   - **Demo talking point:** "Cassidy remembers your preferences across conversations"

3. Send: `What preferences do you have for me?`
   - **Expected:** Cassidy lists back:
     - Work hours (morning-focused, no after 4 PM)
     - Any other stored preferences
   - **Demo talking point:** "Full transparency into what Cassidy knows about you"

---

### Test 7: Multi-Agent Coordination
**Objective:** Verify Cassidy routes complex queries to specialized agents

**Test Steps:**
1. Send: `I need to hire a new engineer AND set up their laptop AND get them access to the dev portal. Walk me through the whole onboarding process.`
   - **Expected:** Cassidy identifies 3 distinct domains (HR, IT, Security)
   - **Check:** Response routes to appropriate agents/teams:
     - HR agent for hiring workflow
     - IT agent for device provisioning
     - Security agent for access provisioning
   - **Demo talking point:** "Cassidy knows when to involve specialists"

2. Follow-up: `Which agent handled access provisioning?`
   - **Expected:** Cassidy names the specific agent
   - **Check:** Response includes agent reasoning (confidence score)
   - **Demo talking point:** "Full transparency into agent selection logic"

---

### Test 8: Error Handling & Graceful Degradation
**Objective:** Verify Cassidy handles failures elegantly

**Test Steps:**
1. Send: `Create a Teams meeting with [non-existent-user@org]`
   - **Expected:** Cassidy fails gracefully
   - **Check:** Response says: "I couldn't find that user. Did you mean...?" + suggests similar names
   - **Demo talking point:** "Cassidy suggests fixes rather than just failing"

2. Send: `Get me the salary data for the team`
   - **Expected:** Cassidy respects permissions
   - **Check:** Response: "I don't have access to salary data. You may have access in HR portal."
   - **Demo talking point:** "Cassidy respects security boundaries"

3. If Azure OpenAI service is down, send any query:
   - **Expected:** Fallback response
   - **Check:** Cassidy either:
     - Returns cached answer if available
     - Suggests alternate action (e.g., "Try again in a moment")
   - **Demo talking point:** "Robust even when services hiccup"

---

### Test 9: Voice Interaction (Optional)
**Objective:** Verify voice commands and voice-optimized responses

**Prerequisites:**
- Your Teams phone configured
- Cassidy voice endpoint available

**Test Steps:**
1. Call Cassidy's voice endpoint (or initiate from Teams app if available)
   - **Expected:** Cassidy answers with greeting: "Hi, this is Cassidy. What can I help with?"

2. Say: `What's on my calendar tomorrow?`
   - **Expected:** Cassidy responds with short, spoken summary
   - **Check:** Response is:
     - Conversational (no markdown, no bullet syntax)
     - Under 30 seconds
     - Natural language (not robotic)
   - **Demo talking point:** "Cassidy adapts responses for spoken word"

3. Follow-up: `Remind me to follow up with sales`
   - **Expected:** Cassidy creates a reminder
   - **Check:** Reminder appears in your task list within 30 seconds
   - **Demo talking point:** "Voice is a first-class interaction mode"

---

### Test 10: Complex Multi-Turn Conversation
**Objective:** Verify conversation continuity and context stacking

**Test Steps:**
```
YOU: "I'm planning the annual kickoff for Q2"
CASSIDY: "Got it! What size team and budget?"

YOU: "50 people, $20k"
CASSIDY: "Thanks. What location or virtual/hybrid?"

YOU: "Austin, Texas in person"
CASSIDY: "Noted. What dates/duration?"

YOU: "April 15-17, 3 days"
CASSIDY: [Breaks down into tasks]
  - Search venues in Austin for 50 people, April 15-17
  - Estimate catering costs (~$100/person)
  - Create invite draft
  - Send to execs for approval
```

**Expected:**
- Cassidy maintains context across 4+ turns
- Final decomposition uses all accumulated info
- Never asks for clarification twice

**Check:**
- Response shows Austin venue search, not generic
- Task estimates reflect 50-person, 3-day event
- Asks for next step (budget approval? timeline?)

**Demo talking point:** "Cassidy converses naturally with full context awareness"

---

## Demo Script (5-minute walkthrough)

### Opening
"Cassidy is an autonomous operations agent for enterprise teams. Unlike a chatbot, Cassidy executes work."

### Demo Sequence
1. **Basic NLU** (30 sec)
   - Send: `What's on my calendar this week?`
   - Point out: Specific times, not just "you're busy"

2. **Task Decomposition** (60 sec)
   - Send: `Plan the customer summit for Q3`
   - Show: Ordered subtasks with dependencies
   - Point out: "Cassidy breaks this into actionable work, not just advice"

3. **Autonomous Execution** (30 sec)
   - Send: `Go ahead and start`
   - Check Planner/email after 30 seconds
   - Point out: "Tasks auto-created, emails sent automatically"

4. **Context & Memory** (30 sec)
   - Send: `What am I working on?`
   - Cassidy lists the Q3 summit tasks
   - Point out: "Cassidy remembers the context from 2 minutes ago"

5. **Proactive Notifications** (15 sec)
   - Mention: "If something falls behind, Cassidy reminds you automatically"
   - If demo shows overdue task, trigger proactive message

6. **Closing**
   - "Cassidy handles the operations busywork. You focus on strategy."

---

## Troubleshooting Common Test Failures

| Issue | Diagnosis | Fix |
|-------|-----------|-----|
| "Cassidy doesn't respond in Teams" | Agent not running or bot not configured | Check: `OPS_TEAMS_CHANNEL_ID` in `.env`, restart container |
| "Calendar queries return no data" | Missing Graph permissions | Check: `Calendars.ReadWrite` in customBlueprintPermissions |
| "Tasks not auto-creating" | Planner API error or no target plan | Verify target Planner plan ID, check logs for 403 errors |
| "Meeting transcripts not detected" | Cassidy not invited or Graph subscription failed | Add Cassidy to meeting as attendee, check subscription webhook health |
| "Proactive messages not sending" | Quiet hours active or user in cooldown | Send test during 9 AM–5 PM, wait 10+ min between triggers |
| "Voice calls not working" | Teams communication endpoint not configured | Verify Graph Communication API is enabled in Azure app |

---

## Metrics & Success Criteria

After completing all tests, Cassidy "passes" if:

- [ ] Responds to all natural language queries in <3 seconds
- [ ] Decomposes complex goals into 3-5 subtasks with dependencies
- [ ] Executes at least 1 subtask autonomously (task creation, email send)
- [ ] Maintains context across 3+ conversation turns
- [ ] Proactively notifies for overdue items within 10 minutes
- [ ] Generates formatted report with data from 3+ sources
- [ ] Handles missing info gracefully (suggests fixes, doesn't fail)
- [ ] Respects user preferences stored from earlier conversations
- [ ] Routes multi-domain queries to appropriate agents
- [ ] (If voice enabled) Answers voice queries in <5 seconds with natural speech

---

## Recording Test Results

**Date:** [___________]  
**Tester:** [___________]  
**Environment:** [Prod / Staging]

| Test # | Feature | Status | Notes |
|--------|---------|--------|-------|
| 1 | NLU & Context | ✅/⚠️/❌ | |
| 2 | Task Decomposition | ✅/⚠️/❌ | |
| 3 | Meeting Intelligence | ✅/⚠️/❌ | |
| 4 | Proactive Notifications | ✅/⚠️/❌ | |
| 5 | Report Generation | ✅/⚠️/❌ | |
| 6 | Memory & Preferences | ✅/⚠️/❌ | |
| 7 | Multi-Agent Coordination | ✅/⚠️/❌ | |
| 8 | Error Handling | ✅/⚠️/❌ | |
| 9 | Voice Interaction | ✅/⚠️/❌ | |
| 10 | Complex Conversation | ✅/⚠️/❌ | |

**Overall Status:** ✅ Ready / ⚠️ Minor Issues / ❌ Needs Work

**Issues Found:**
- [ Issue 1 ]
- [ Issue 2 ]

---

## Next Steps After Testing

1. **If all ✅:** Deploy to production, schedule team kickoff
2. **If ⚠️ issues:** Log issues to GitHub, prioritize fixes, retest
3. **If blockers ❌:** Engage agent team, review logs, update deployment config

---

## Test Automation (Optional)

For hands-off regression testing, see [CI/CD pipeline configuration](cassidy/publish/.deployment) to enable automated test suites against staging instances.
