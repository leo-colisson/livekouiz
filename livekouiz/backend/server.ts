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
import ViteExpress from 'vite-express';

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
const escapeColon = (key) => key.replaceAll(":", "::");
const redisKeyRoom = (roomName) => `room-info:${roomName}`;
const redisKeyUsers = (roomName, userName) => `room-users:${escapeColon(roomName)}-:-${escapeColon(userName)}`;
const redisKeyQuestion = (roomName) => `room-question:${roomName}`;
const redisKeyQuestionSubscribe = (roomName) => `room-question-subscribe:${roomName}`;
const redisKeyRoomAcceptingAnswers = (roomName) => `room-accepting-answrs:${roomName}`;
// This is a hset, with the key being the name of the user, and the key its answer
const redisKeyListUserAnswers = (roomName) => `room-list-user-answers:${roomName}`
// Outputs just {newAnswer: true}, then we re-fetch the whole list of answers manually
const redisKeyNewAnswerChannel = (roomName) => `room-new-answer:${roomName}`

async function redisCheckUserAuth(roomName, userName, userToken) {
  const user = await redis_get_obj_or_null(redisKeyUsers(roomName, userName));
  if (user === null) {
    return False
  } else {
    return user.userToken === userToken
  }
}

// The GraphQL schema
//import typeDefs from './schema.graphql'
let typeDefs;
import fs from 'fs';
if (process.env.NODE_ENV === 'production') {
  //import typeDefs from './schema.graphql'
  typeDefs = (await import('./schema.graphql')).default;
} else {
  typeDefs = fs.readFileSync(import.meta.dirname + '/schema.graphql', 'utf8');
}

// A map of functions which return data for the schema.
const resolvers = {
  Query: {
    hello: () => 'world',
    getAllAnswers: async (_, args) => {
      const { roomName, token} = args;
      const room = await redis_get_obj_or_null(redisKeyRoom(roomName));
      if (room && room.token === token) {
        const allAnswers = await redis.hgetall(redisKeyListUserAnswers(roomName));
        console.log("allAnswers", allAnswers);
        return Object.values(allAnswers).map(x => JSON.parse(x));
      } else {
        return {__typename: "BadAuthentification"}
      }
    },
  },
  Subscription: {
    hello: {
      // Example using an async generator
      subscribe: async function* () {
        for await (const word of ['Hello :-D', 'Bonjour', 'Ciao']) {
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
    answers: {
      //subscribe: (_, args) => pubsub.asyncIterator(redisKeyQuestionSubscribe(args.roomName)),
      subscribe: async function* (_, args) {
        const {roomName, token} = args;
        const room = await redis_get_obj_or_null(redisKeyRoom(roomName));
        if (room && room.token === token) {
          const allAnswers = await redis.hgetall(redisKeyListUserAnswers(roomName));
          yield {answers: {__typename: "QuestionAnswerList",
                           answers: Object.values(allAnswers).map(x => JSON.parse(x))}}
          const iterMessages = pubsub.asyncIterator(redisKeyNewAnswerChannel(args.roomName));
          while (true) {
            const message = await iterMessages.next();
            console.log("message", message)
            if(message.value.newAnswer) {
              const allAnswers = await redis.hgetall(redisKeyListUserAnswers(roomName));
              yield {answers: {__typename: "QuestionAnswerList",
                               answers: Object.values(allAnswers).map(x => JSON.parse(x))}}
            }
            //yield message.value
          }
        } else {
          yield {answers: {__typename: "BadAuthentification"}}
        }
      },
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
    newUser: async (_, args) => {
      const {roomName, userName, password} = args;
      const room = await redis_get_obj_or_null(redisKeyRoom(roomName));
      if (room === null) {
        return {__typename: "RoomDoesNotExist"}
      } else {
        const user = await redis_get_obj_or_null(redisKeyUsers(roomName, userName));
        if (user === null) {
          // We create the user
          const salt = await bcrypt.genSalt();
          const hashed = await bcrypt.hash(password, salt);
          const token = uuidv4();
          const u = {__typename: "User", roomName: roomName, userName: userName, hashedPassword: hashed, userToken: token};
          await redis_set_obj(redisKeyUsers(roomName, userName), u);
          return u
        } else {
          // The user already exists
          const res = await bcrypt.compare(password, user.hashedPassword);
          if (res) {
            return user
          } else {
            return {__typename: "UserAlreadyRegistered"}
          }
        }
      }
    },
    newQuestion: async (_, args) => {
      const { roomName, token, question } = args;
      const room = await redis_get_obj_or_null(redisKeyRoom(roomName));
      if (room && room.token === token) {
        const typename = Object.keys(question)[0];
        const uuid = uuidv4();
        const q = {...question[typename], uuid: uuid, __typename: typename};
        await redis_set_obj(redisKeyQuestion(roomName), q);
        await redis.del(redisKeyListUserAnswers(roomName)); // Reset the questions
        await redis_set_obj(redisKeyRoomAcceptingAnswers(roomName), "true");
        pubsub.publish(redisKeyQuestionSubscribe(roomName), q);
        return q;
      } else {
        return {__typename: "WrongToken"};
      }
    },
    newAnswer: async (_, args) => {
      const { roomName, questionUuid, userName, userToken, answer } = args;
      const room = await redis_get_obj_or_null(redisKeyRoom(roomName));
      if (room === null) {
        return {__typename: "RoomDoesNotExist"}
      } else {
        const question = await redis_get_obj_or_null(redisKeyQuestion(roomName));
        if (question === null || question.uuid != questionUuid) {
          return {__typename: "QuestionDoesNotExist"}
        } else {
          if (!redisCheckUserAuth(roomName, userName, userToken)) {
            return { __typename: "BadAuthentification" }
          } else {
            const acceptNew = await redis_get_obj_or_null(redisKeyRoomAcceptingAnswers(roomName));
            if (acceptNew !== "true") {
              return {__typename: "TimeIsOut"}
            } else {
              const uuid = uuidv4();
              const ans = {...answer, uuid: uuid, userName: userName, __typename: "QuestionAnswer"};
              await redis.hset(redisKeyListUserAnswers(roomName), userName, JSON.stringify(ans));
              pubsub.publish(redisKeyNewAnswerChannel(roomName), {newAnswer: true});
              return ans
            }
          }
        }
      }
    },
    timeIsOut: async (_, args) => {
      const { roomName, token} = args;
      const room = await redis_get_obj_or_null(redisKeyRoom(roomName));
      if (room && room.token === token) {
        await redis_set_obj(redisKeyRoomAcceptingAnswers(roomName), "false");
        return {__typename: "Success" }
      } else {
        return {__typename: "BadAuthentification"}
      }
    },
  }
};

  // Create the schema, which will be used separately by ApolloServer and
  // the WebSocket server.
  const schema = makeExecutableSchema({ typeDefs, resolvers });

// Create an Express app and HTTP server; we will attach both the WebSocket
// server and the ApolloServer to this HTTP server.
const app = express();
const httpServer = createServer(app);

// Create our WebSocket server using the HTTP server we just set up.
const wsServer = new WebSocketServer({
  server: httpServer,
  //  path: '/subscriptions',
  path: '/graphql',
});
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
app.use('/graphql', cors<cors.CorsRequest>(), express.json(), expressMiddleware(server));

const PORT = 4043;
// Now that our HTTP server is fully set up, we can listen to it.
httpServer.listen(PORT, () => {
  console.log(`Server is now running on http://localhost:${PORT}/graphql`);
});

ViteExpress.config({ 
   inlineViteConfig: { 
      base: "/", 
      build: { outDir: "build" }
   } 
});

ViteExpress.bind(app, httpServer);
// 
// 
// ViteExpress.listen(httpServer, 3000, () =>
//   console.log("Server is listening on port 3000..."),
// );
