module.exports = {
  apps: [
    // Core API Services (unchanged)
    {
      name: 'bharat-server',
      script: 'server.ts',
      interpreter: 'tsx',
      cwd: 'D:/Github/bharat-stock-intelligence',
      env: { PORT: 3000, NODE_ENV: 'production' },
      autorestart: true, max_restarts: 10, restart_delay: 3000,
      out_file: 'logs/bharat-server-out.log', error_file: 'logs/bharat-server-err.log'
    },
    {
      name: 'ml-api',
      script: 'src/server/python_api.py',
      interpreter: 'backend-python/venv/Scripts/python.exe',
      cwd: 'D:/Github/bharat-stock-intelligence',
      env: { PYTHON_API_PORT: 8000, PYTHONPATH: 'src/server' },
      autorestart: true, max_restarts: 10, restart_delay: 3000,
      out_file: 'logs/ml-api-out.log', error_file: 'logs/ml-api-err.log'
    },
    {
      name: 'chatbot',
      script: 'src/server/chatbot/app.py',
      interpreter: 'backend-python/venv/Scripts/python.exe',
      cwd: 'D:/Github/bharat-stock-intelligence',
      env: { CHATBOT_PORT: 8001, PYTHONPATH: 'src/server' },
      autorestart: true, max_restarts: 10, restart_delay: 3000,
      out_file: 'logs/chatbot-out.log', error_file: 'logs/chatbot-err.log'
    },
    {
      name: 'alphaquant-api',
      script: 'backend-python/main.py',
      interpreter: 'backend-python/venv/Scripts/python.exe',
      cwd: 'D:/Github/bharat-stock-intelligence',
      env: { PYTHON_PORT: 8002, PYTHONPATH: 'backend-python' },
      autorestart: true, max_restarts: 10, restart_delay: 3000,
      out_file: 'logs/alphaquant-out.log', error_file: 'logs/alphaquant-err.log'
    },
    // TradingView Webhook Handler (NEW)
    {
      name: 'tv-webhook',
      script: 'tv_webhook_handler.py',
      interpreter: 'backend-python/venv/Scripts/python.exe',
      cwd: 'D:/Github/bharat-stock-intelligence',
      env: { TV_WEBHOOK_PORT: 8003, PYTHONPATH: 'src/server' },
      autorestart: true, max_restarts: 10, restart_delay: 3000,
      out_file: 'logs/tv-webhook-out.log', error_file: 'logs/tv-webhook-err.log'
    },
    // Hermes Gateway (REPLACES BullMQ Cron)
    {
      name: 'hermes-gateway',
      script: 'hermes',
      args: 'gateway run',
      cwd: 'D:/Github/bharat-stock-intelligence',
      env: {
        HERMES_HOME: 'C:\\Users\\amitk\\.hermes',
        PATH: 'C:\\Users\\amitk\\.hermes\\bin;' + process.env.PATH
      },
      autorestart: true, max_restarts: 10, restart_delay: 5000,
      out_file: 'logs/hermes-gateway-out.log', error_file: 'logs/hermes-gateway-err.log'
    },
    // Hermes CLI (interactive)
    {
      name: 'hermes-cli-ops',
      script: 'hermes',
      args: '--profile bharat-ops',
      cwd: 'D:/Github/bharat-stock-intelligence',
      env: {
        HERMES_HOME: 'C:\\Users\\amitk\\.hermes',
        PATH: 'C:\\Users\\amitk\\.hermes\\bin;' + process.env.PATH
      },
      autorestart: false,
      out_file: 'logs/hermes-cli-ops-out.log', error_file: 'logs/hermes-cli-ops-err.log'
    },
    {
      name: 'hermes-cli-research',
      script: 'hermes',
      args: '--profile bharat-research',
      cwd: 'D:/Github/bharat-stock-intelligence',
      env: {
        HERMES_HOME: 'C:\\Users\\amitk\\.hermes',
        PATH: 'C:\\Users\\amitk\\.hermes\\bin;' + process.env.PATH
      },
      autorestart: false,
      out_file: 'logs/hermes-cli-research-out.log', error_file: 'logs/hermes-cli-research-err.log'
    }
  ]
};
