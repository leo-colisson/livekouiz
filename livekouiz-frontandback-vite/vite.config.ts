import { defineConfig } from 'vite'
import graphqlLoader from "vite-plugin-graphql-loader";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [graphqlLoader()],
  // server: {
  //   hmr: {
  //     port: 4000
  //   }
  // },
})
