# Hosted Studio

Hosted Cozy Studio runs Studio on a server for one owner: a Neon Function with the UI on Vercel. Agents reach it through its remote MCP endpoint instead of the local bridge. The tools, the rules in [SKILL.md](../SKILL.md) and the other references apply, with the differences below. Deploying and configuring Hosted Studio is the owner's work; `docs/HOSTING.md` in the Studio repository covers it.

You are on Hosted Studio when the server instructions start with `Hosted Cozy Studio` and the `overview` topic starts with `Hosted Cozy Studio at <origin>` instead of `Studio checkout: <path>`.

## Process

1. Connect.
   - The owner registers the server as HTTP MCP at `<origin>/mcp` with the header `Authorization: Bearer <agent token>`, for example `claude mcp add --transport http cozy-studio <origin>/mcp --header "Authorization: Bearer <agent token>"`. The owner creates the token with `bun run hosted:admin token create <name>`. Follow **Leave user-only actions to the user**: never ask for, print or log the token.
   - HTTP 401: the token is missing, wrong or revoked. Ask the owner to register the server again with a valid token.
   - `Cozy Studio is starting up. Try again shortly.` (HTTP 503): an instance is starting. Send the call again after a few seconds.
   - Done when the client lists the Studio tools and `studio_status` answers.

2. Check state.
   - Call `studio_status` as [SKILL.md](../SKILL.md) step 1 says. Hosted Studio returns no update `notice`.
   - Agent access works as on local Studio. The owner sets it in the hosted UI at Settings > Advanced & maintenance. [configure.md](configure.md) lists the tools of each level.
   - Done when you know the access level.

3. Apply the hosted differences to every step of the task.

   | Local Studio                                                          | Hosted Studio                                                                                                                                                                                                                    |
   | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `studio_guide` works while Studio is offline.                         | The hosted server answers `studio_guide`, so it needs the server to answer.                                                                                                                                                      |
   | Image rows carry `thumbnailPath` and `filePath`.                      | Image rows carry `thumbnailUrl` and `publicUrl`: signed links, valid for 24 hours, that need no token. For **Look through thumbnails**, open `thumbnailUrl`, or `publicUrl` for full detail. Read the row again for fresh links. |
   | `studio_import_reference_file` reads Allowed import folders.          | Unavailable. Use `studio_import_reference` with base64 bytes and their `sha256`.                                                                                                                                                 |
   | `studio_onboarding`; ChatGPT Sign in in Settings > Accounts & models. | Unavailable. The owner copies a local ChatGPT sign-in with `bun run hosted:admin import-chatgpt`. ChatGPT is the hosted provider; `studio_providers` shows readiness.                                                            |
   | `studio_updates` and `studio_apply_update`.                           | Unavailable. The owner updates Hosted Studio by deploying a new version.                                                                                                                                                         |
   | Every workflow.                                                       | Sprite Atlas and Animation Sequence are unavailable.                                                                                                                                                                             |
   | Storage audit, Duplicate images, Library archives, Output Folders.    | Unavailable. [maintenance-and-cleanup.md](maintenance-and-cleanup.md) applies only to its read-only tool checks.                                                                                                                 |
   | Style packs install from the Settings source.                         | `studio_available_extensions`, `studio_install_extension` and `studio_remove_extension` work. The owner's deploy sets the pack source. A pack installed on one instance reaches the others within about 15 seconds.              |
   - A job runs on the instance that accepted it. When that instance stops, a sweep every 15 minutes resumes the job, and a ChatGPT job that was already submitted moves to `needs_review` instead of being sent twice. A job that stays `running` is not stuck: do not cancel and regenerate it unless the user asks.
   - Done when each step uses a tool that Hosted Studio offers, and you told the user each gap that only the owner can close.
