import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer';
import { createServer } from 'http';
import express from 'express';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { WebSocketServer } from 'ws';
import { useServer } from 'graphql-ws/lib/use/ws';
import cors from 'cors';
//const bcrypt = require('bcrypt');
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { RedisPubSub } from 'graphql-redis-subscriptions';
const pubsub = new RedisPubSub();
import Redis from 'ioredis';
//const Redis = require("ioredis");
const redis = new Redis();

async function redis_get_obj_or_null(key) {
  const str = await redis.get(key);
  console.log("str", str)
  if (str) {
    return JSON.parse(str)
  } else {
    return null
  }
}

async function redis_set_obj(key, obj) {
  await redis.set(key, JSON.stringify(obj))
}

// Redis key names
const redisKeyRoom = (roomName) => `room-info:${roomName}`;
const redisKeyQuestion = (roomName) => `room-question:${roomName}`;
const redisKeyQuestionSubscribe = (roomName) => `room-question-subscribe:${roomName}`;

// The GraphQL schema
//import { readFileSync } from 'fs';
//const typeDefs = readFileSync('./schema.graphql', { encoding: 'utf-8' });
import typeDefs from './schema.graphql'

// A map of functions which return data for the schema.
const resolvers = {
  Query: {
    hello: () => 'wwoorld',
  },
  Subscription: {
    hello: {
      // Example using an async generator
      subscribe: async function* () {
        for await (const word of ['Hello', 'Bonjour', 'Ciao']) {
          yield { hello: word };
        }
      },
    },
    questions: {
      //subscribe: (_, args) => pubsub.asyncIterator(redisKeyQuestionSubscribe(args.roomName)),
      subscribe: async function* (_, args) {
        // Fetch the initial question from Redis
        const question = await redis_get_obj_or_null(redisKeyQuestion(args.roomName));
        yield {questions: question};
        const iterMessages = pubsub.asyncIterator(redisKeyQuestionSubscribe(args.roomName));
        while (true) {
          const message = await iterMessages.next();
          console.log("message", message)
          yield {questions: message.value}
          //yield message.value
        }
        // for await (const message of iterMessages()) {
        //   yield message;
        // }
      }
    },
  },
  Mutation: {
    newRoom: async (_, args) => {
      const {roomName, password} = args;
      console.log(roomName)
      const room = await redis_get_obj_or_null(redisKeyRoom(roomName));
      console.log("foo", room)
      if (room === null) {
        // We create the room
        const salt = await bcrypt.genSalt();
        const hashed = await bcrypt.hash(password, salt);
        const token = uuidv4();
        const newRoom = {
          __typename: "Room",
          name: roomName,
          adminHashedPassword: hashed,
          token: token
        }
        console.log("hashed", hashed)
        console.log("hashed", hashed)
        redis_set_obj(redisKeyRoom(roomName), newRoom);
        return newRoom
      } else {
        const res = await bcrypt.compare(password, room.adminHashedPassword);
        if (res) {
          return room
        } else {
          return {__typename: "WrongPassword"}
        }
      }
    },
    newQuestion: async (_, args) => {
      const { roomName, token, question } = args;
      const room = await redis_get_obj_or_null(redisKeyRoom(roomName));
      if (room && room.token === token) {
        const typename = Object.keys(question)[0];
        const q = {...question[typename], __typename: typename};
        await redis_set_obj(redisKeyQuestion(roomName), q);
        pubsub.publish(redisKeyQuestionSubscribe(roomName), q);
        return q;
      } else {
        return {__typename: "WrongToken"};
      }
    }
  },
};

  // Create the schema, which will be used separately by ApolloServer and
  // the WebSocket server.
  const schema = makeExecutableSchema({ typeDefs, resolvers });

// Create an Express app and HTTP server; we will attach both the WebSocket
// server and the ApolloServer to this HTTP server.
export const app = express();
const httpServer = createServer(app);

// Create our WebSocket server using the HTTP server we just set up.
const wsServer = new WebSocketServer({
  server: httpServer,
  //port: 4000,
  //  path: '/subscriptions',
  path: '/graphql',
});
wsServer.on('error', console.error);
// Save the returned server's info so we can shutdown this server later
const serverCleanup = useServer({ schema }, wsServer);

// Set up ApolloServer.
const server = new ApolloServer({
  schema,
  plugins: [
    // Proper shutdown for the HTTP server.
    ApolloServerPluginDrainHttpServer({ httpServer }),

    // Proper shutdown for the WebSocket server.
    {
      async serverWillStart() {
        return {
          async drainServer() {
            await serverCleanup.dispose();
          },
        };
      },
    },
  ],
});

await server.start();
var corsOptions = {
  changeOrigin: true,
}
app.use('/graphql', cors<cors.CorsRequest>(corsOptions), express.json(), expressMiddleware(server));

if (!process.env['VITE']) { // When running from `vite` there is no need to call `app.listen`
  const PORT = 4000;
  // Now that our HTTP server is fully set up, we can listen to it.
  httpServer.listen(PORT, () => {
    console.log(`Server is now running on http://localhost:${PORT}/graphql`);
  });
}
