// A port nothing listens on, from the OS: test files run in parallel, and random ports collided. (Each
// file then waits up to 30 s for its stub to answer: under that load, 5 s wasn't always enough.)
import net from 'node:net';

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}
