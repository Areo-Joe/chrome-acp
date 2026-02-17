import { defineConfig } from '@rspress/core';

export default defineConfig({
  root: 'docs',
  base: '/chrome-acp/',
  title: 'Chrome ACP',
  description: 'A Chrome extension to chat with AI agents. Give them the power to see and interact with your browser.',
  icon: '/favicon.png',
  logo: '/logo.png',
  themeConfig: {
    socialLinks: [
      {
        icon: 'github',
        mode: 'link',
        content: 'https://github.com/Areo-Joe/chrome-acp',
      },
    ],
    footer: {
      message: '© 2025 Chrome ACP',
    },
  },
  markdown: {
    showLineNumbers: true,
  },
});

