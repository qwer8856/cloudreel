import 'dotenv/config';
import { createPanel } from './app.mjs';

try {
  const panel = await createPanel();
  const port = Number(process.env.PORT || 8787);
  const server = panel.app.listen(port, panel.host, () => {
    console.log(`CloudReel: http://${panel.host}:${port}`);
    console.log(
      panel.engine.ready ? `rclone ${panel.engine.version.version} 已连接` : panel.engine.error,
    );
  });
  server.on('error', async (error) => {
    console.error(`监听失败：${error.message}`);
    await panel.close();
    process.exit(1);
  });
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, async () => {
      if (closing) return;
      closing = true;
      server.close();
      await panel.close();
      process.exit(0);
    });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
