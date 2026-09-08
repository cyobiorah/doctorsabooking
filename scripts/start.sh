#!/bin/sh
set -eu
export DATABASE_URL="mysql://root:$(cat /run/demo-secrets/DB_PASSWORD)@${DB_HOST:-db}:3306/${DB_NAME:-doctorsa}"
npx prisma migrate deploy
if [ "${SERVICE:-app}" = "test" ]; then
  exec npm test
fi
if [ "${SERVICE:-app}" = "app" ]; then
  npm run seed
fi
exec npm start
