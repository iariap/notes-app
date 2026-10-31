import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
	testDir: './tests/e2e',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
	use: {
		baseURL: BASE_URL,
		trace: 'on-first-retry'
	},
	projects: [
		{
			name: 'mobile',
			use: {
				...devices['Desktop Chrome'],
				viewport: { width: 375, height: 667 },
				hasTouch: true,
				isMobile: true
			}
		},
		{
			name: 'tablet',
			use: { ...devices['Desktop Chrome'], viewport: { width: 768, height: 1024 } }
		},
		{
			name: 'desktop',
			use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } }
		}
	],
	webServer: {
		command: 'pnpm build && pnpm preview --port 4173 --strictPort',
		url: BASE_URL,
		reuseExistingServer: !process.env.CI,
		timeout: 180_000
	}
});
