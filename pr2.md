## Summary

Replace generic "Sorry, I was unable to complete that request" error messages with actionable details showing what went wrong.

### Before
> Sorry, I was unable to complete that request. Please try rephrasing.

### After
> Sorry, I wasn't able to complete that after 3 attempt(s). The AI response had compile errors:
> ```
> Line 5: Unknown command block "EDTI" — did you mean "EDIT"?
> ```
> Try rephrasing your request or simplifying what you're asking for.

### Why
When the AI generates an invalid response and all 3 retries fail, users currently get zero feedback about what went wrong. This makes it impossible to adjust their prompt. Now they see:
- Number of attempts made
- The first few lines of the actual error (compile or runtime)
- A suggestion to rephrase

Both compile errors and runtime execution errors are covered.

### Files changed
- `engine/backend/src/ws/editor_ws.ts` — enhanced error messages in `runLLMWithRetry`
