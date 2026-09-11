import 'dotenv/config';
import { createApp } from './app';

const PORT = process.env.PORT || 3001;
const app = createApp();

app.listen(PORT, () => {
  console.log(`\n🚀 Job Application Agent API running on http://localhost:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/api/health\n`);
});

export default app;
