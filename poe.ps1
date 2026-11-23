# Local entry point; no global app settings or network services.
& node "$PSScriptRoot/poe-db/scripts/agent.mjs" @args
exit $LASTEXITCODE
