/**
 * PM2 process definition.
 *
 *   pm2 start deploy/ecosystem.config.cjs
 *   pm2 save && pm2 startup
 *
 * Run from the repo root on the server.
 */

module.exports = {
  apps: [
    {
      name: 'no-mercy-uno',

      // The tsup bundle. @nmu/engine and @nmu/shared are inlined into it, so
      // this one file is the whole server.
      script: 'dist/index.js',
      cwd: '/var/www/no-mercy-uno/apps/server',

      /**
       * ONE instance, fork mode. This is not a tuning choice -- it is a
       * correctness requirement.
       *
       * Rooms live in an in-process Map and Socket.IO has no Redis adapter
       * here. Under `cluster` with 2+ instances, two players who joined the
       * same room could land on different workers: each would see a room
       * containing only themselves, neither could start a game, and every
       * broadcast would reach half the table. It would look like a flaky
       * network rather than a configuration mistake, which is what makes it
       * worth spelling out.
       *
       * To scale past one process, add @socket.io/redis-adapter and move room
       * state out of memory first. Until then: instances 1.
       */
      instances: 1,
      exec_mode: 'fork',

      // The app reads apps/server/.env itself at boot, so secrets are not
      // duplicated here. Only what PM2 needs to know lives in this file.
      env: {
        NODE_ENV: 'production',
      },

      // A 2 GB Lightsail box has room to spare; this is a backstop against a
      // leak, not a normal operating limit.
      max_memory_restart: '500M',

      // Restart on crash, but stop flapping if it cannot start at all --
      // otherwise a bad .env produces an infinite restart loop that buries the
      // actual error in the log.
      autorestart: true,
      max_restarts: 10,
      min_uptime: '20s',
      restart_delay: 2000,

      // Timestamped, merged logs. `pm2 logs no-mercy-uno` is the first thing to
      // check when something is wrong.
      time: true,
      merge_logs: true,
      out_file: '/var/log/no-mercy-uno/out.log',
      error_file: '/var/log/no-mercy-uno/err.log',

      // The server handles SIGINT/SIGTERM: it stops the sweeper, closes the
      // socket server, and disconnects Prisma. Give it room to finish.
      kill_timeout: 8000,
    },
  ],
};
