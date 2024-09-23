
## Developing

Once you've created a project and installed dependencies with `npm install` (or `pnpm install` or `yarn`), start a development server:

```bash
npm run dev
```

You can also just run the frontend with the backend with:
```bash
npm run dev:frontend
```

## Building

To create a production version of your app, run:

```bash
npm run build
```

to build the front end (you can run `npm run preview` to test it, but the backend will not run). To build and also run the backend on the same port, run:
```bash
npm run build:run:prod
```
(note that you may want to serve the static `build` directory from nginx directly, see https://github.com/szymmis/vite-express/issues/148 for SSR support)
