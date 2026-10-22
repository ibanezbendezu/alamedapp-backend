$ErrorActionPreference='Stop'
# No migraciones ni cambios de flags al iniciar.
npm.cmd run dev -- --hostname 0.0.0.0
exit $LASTEXITCODE
