import { NextApiRequest, NextApiResponse } from 'next';
import { createProxyMiddleware } from 'http-proxy-middleware';

const DEFAULT_SERVER_URL = `http://127.0.0.1:${process.env.HYPERDX_API_PORT}`;

export const config = {
  api: {
    externalResolver: true,
    bodyParser: false,
  },
};

export default (req: NextApiRequest, res: NextApiResponse) => {
  const proxy = createProxyMiddleware({
    changeOrigin: true,
    // logger: console, // DEBUG
    pathRewrite: { '^/api': '' },
    target: process.env.SERVER_URL || DEFAULT_SERVER_URL,
    autoRewrite: true,
    on: {
      proxyReq: (proxyReq, _req, _res) => {
        // Listen for client disconnect
        _res.on('close', () => {
          if (!_res.writableFinished) {
            proxyReq.destroy();
          }
        });
      },
    },
    // ...(IS_DEV && {
    //   logger: console,
    // }),
  });
  return proxy(req, res, error => {
    if (error) {
      console.error(error);
      res.status(500).send('API proxy error');
      return;
    }
    res.status(404).send('Not found');
  });
};
