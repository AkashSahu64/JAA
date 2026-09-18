import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const port = Number(process.env.DASHBOARD_SMOKE_PORT ?? (4175 + Math.floor(Math.random() * 1000)));
const baseUrl = process.env.DASHBOARD_BASE_URL ?? `http://127.0.0.1:${port}`;
let server;

async function waitForServer(url) {
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The static server may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Dashboard server did not become ready at ${url}`);
}

try {
  if (!process.env.DASHBOARD_BASE_URL) {
    server = spawn(process.execPath, ['scripts/serve-web.mjs'], { env: { ...process.env, PORT: String(port) }, stdio: 'inherit' });
  }
  await waitForServer(`${baseUrl}/`);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      sessionStorage.setItem('jobagent.accessToken', 'dashboard-smoke-token');
      sessionStorage.setItem('jobagent.refreshToken', 'dashboard-smoke-refresh');
      sessionStorage.setItem('jobagent.user', JSON.stringify({ id: 'dashboard-smoke-user', email: 'smoke@example.invalid', name: 'Dashboard Smoke' }));
    });
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      const data = path.endsWith('/auth/me')
        ? { id: 'dashboard-smoke-user', email: 'smoke@example.invalid', name: 'Dashboard Smoke' }
        : path.endsWith('/automation/status')
          ? null
          : path.endsWith('/analytics/dashboard')
            ? { jobsDiscovered: 42, qualifiedJobs: 7, applicationsToday: 2, applicationsThisWeek: 9, applicationsThisMonth: 18, interviewRate: 12.5, responseRate: 33.3, averageMatchScore: 84.2, averageATSScore: 91.1, pendingApplications: 3, failedApplications: 1 }
            : path.endsWith('/applications')
              ? { data: [{ id: 'smoke-application', jobId: 'smoke-job', status: 'READY_TO_SUBMIT', version: 1, matchScore: 84, atsScore: 91, createdAt: '2026-09-16T00:00:00.000Z', retryCount: 0, job: { company: 'Smoke Co', title: 'Platform Engineer', location: 'Remote' } }], total: 1, page: 0, pageSize: 100, totalPages: 1 }
              : [];
      if (path.includes('/applications')) console.log(JSON.stringify({ event: 'dashboard_smoke_api', path, data }));
      const payload = path.endsWith('/applications') && data && typeof data === 'object' && 'data' in data
        ? { success: true, data: data.data, total: data.total, page: data.page, pageSize: data.pageSize, totalPages: data.totalPages }
        : { success: true, data };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    });
    await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Job Application Dashboard' }).waitFor();
    await page.getByText('42').waitFor();
    await page.getByRole('button', { name: 'Application Queue' }).click();
    await page.getByRole('heading', { name: 'Application Queue & Tracker' }).waitFor();
    await page.getByText('Smoke Co').first().waitFor();
    console.log('Dashboard browser smoke passed: authenticated dashboard stats and application state rendered from API responses.');
  } finally {
    await browser.close();
  }
} finally {
  if (server) server.kill('SIGTERM');
}
