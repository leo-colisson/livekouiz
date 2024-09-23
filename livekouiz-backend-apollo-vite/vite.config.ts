import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import express from "vite3-plugin-express"
import graphqlLoader from "vite-plugin-graphql-loader";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), graphqlLoader(), express('src/server')],
})
