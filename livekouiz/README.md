
## Developing

I typically have direnv installed to automatically load the environment in my current shell, but you can also just run, if you have nix installed:
```bash
$ nix develop
```
To enter into a shell with everything you need (and same version as mine). Note that since we require a very recent version of Redis, it will take some time to compile it the first time you run this command. If you are on NixOs, I also advise you to enable `nix-ld`, you will save you lot's of headaches, especially with nodejs development that really enjoy using pre-built binaries.

Once you've created a project and installed dependencies with `npm install`, start a development server:

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

to build the static version of the front end (you can run `npm run preview` to test it, but the backend will not run). To build and also run the backend on the same port, run:
```bash
npm run build:run
```
(note that you may want to serve the static `build` directory from nginx directly, see https://github.com/szymmis/vite-express/issues/148 for SSR support)

Note that you need Redis 7.4.0 as we use HEXPIRE, but we plan to move to Valkey when it supports it.

## Building into a nix package

TODO
