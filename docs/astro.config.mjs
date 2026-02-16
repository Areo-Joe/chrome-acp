// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
	site: 'https://areo-joe.github.io',
	base: '/chrome-acp',
	trailingSlash: 'always',
	integrations: [
		starlight({
			title: 'Chrome ACP',
			description: 'A Chrome extension to chat with AI agents. Give them the power to see and interact with your browser.',
			logo: {
				src: './src/assets/logo.png',
				alt: 'Chrome ACP',
			},
			favicon: '/favicon.png',
			customCss: [
				'./src/styles/custom.css',
			],
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/Areo-Joe/chrome-acp' },
			],
			sidebar: [
				{
					label: 'Start Here',
					autogenerate: { directory: 'getting-started' },
				},
				{
					label: 'Guides',
					autogenerate: { directory: 'guides' },
				},
				{
					label: 'Reference',
					autogenerate: { directory: 'reference' },
				},
			],
			editLink: {
				baseUrl: 'https://github.com/Areo-Joe/chrome-acp/edit/main/docs/',
			},
			lastUpdated: true,
		}),
	],
});
