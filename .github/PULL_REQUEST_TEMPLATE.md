## What & why

<!-- Short description of the change and the problem it solves. For behavior
     changes, link the issue where the approach was discussed. -->

## Checklist
- [ ] Discussed in an issue first (for anything beyond a small fix)
- [ ] Upholds the core promises: no silent overwrite, storage sees only
      ciphertext, deletions via trash, every applied change appears in the
      sync log with a reason
- [ ] No Node-only APIs in code the plugin ships (it runs on mobile too)
- [ ] Tests added/updated
- [ ] Docs updated in the same PR
- [ ] No secrets in logs or error messages
