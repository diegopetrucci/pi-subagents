// Keep the default unit suite hermetic even when run from an isolated Pi/TLH profile.
// Tests that exercise PI_CODING_AGENT_DIR set it explicitly inside the test body.
delete process.env.PI_CODING_AGENT_DIR;
