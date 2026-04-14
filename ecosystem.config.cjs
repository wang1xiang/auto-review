module.exports = {
  apps: [
    {
      name: 'auto-review',
      script: 'dist/index.js',
      args: 'start',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
      },
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
    {
      name: 'ngrok',
      cmd: `ngrok http 8081 --log=stdout --log-format=json`,
      autorestart: true,
      max_memory_restart: '100M',
      out_file: './logs/ngrok.log',
      error_file: './logs/ngrok.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
