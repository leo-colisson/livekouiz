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
const redisKeyRoom = (roomName) => `room-info:${roomName}`;
const redisKeyQuestion = (roomName) => `room-question:${roomName}`;
const redisKeyQuestionSubscribe = (roomName) => `room-question-subscribe:${roomName}`;

// The GraphQL schema
//import typeDefs from './schema.graphql'

const typeDefs = `
type Room {
  name: String!
  adminHashedPassword: String!
  token: String!
}

type QuestionMultipleChoice {
  question: String
  nbChoices: Int!
}
input QuestionMultipleChoiceInput {
  question: String
  nbChoices: Int!
}

type QuestionText {
  question: String
}
input QuestionTextInput {
  question: String
}

type QuestionNumber {
  question: String
}
input QuestionNumberInput {
  question: String
}

union Question = QuestionMultipleChoice | QuestionText | QuestionNumber
# Note the greatest way to allow union type as input IMO... But that's graphQL life.
input QuestionInput @oneOf {
  QuestionMultipleChoice: QuestionMultipleChoiceInput
  QuestionText: QuestionTextInput
  QuestionNumber: QuestionNumberInput
}

### Errors

type WrongPassword {
  _: Boolean # Objects must be non-empty...
}

type WrongToken {
  _: Boolean
}

type Success {
  _: Boolean
}

type Query {
  hello: String
}

type Subscription {
  hello: String
  questions(roomName: String!): Question
}

union NewRoomResult = Room | WrongPassword
union NewQuestionResult = QuestionMultipleChoice | QuestionText | QuestionNumber | WrongToken
type Mutation {
  newRoom(roomName: String!, password: String!): NewRoomResult
  newQuestion(roomName: String!, token: String!, question: QuestionInput!): NewQuestionResult
}
`;

// A map of functions which return data for the schema.
const resolvers = {
  Query: {
    hello: () => 'world',
  },
  Subscription: {
    hello: {
      // Example using an async generator
      subscribe: async function* () {
        for await (const word of ['Hello :)', 'Bonjour', 'Ciao']) {
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

const PORT = 4042;
// Now that our HTTP server is fully set up, we can listen to it.
httpServer.listen(PORT, () => {
  console.log(`Server is now running on http://localhost:${PORT}/graphql`);
});

ViteExpress.bind(app, httpServer);
// 
// 
// ViteExpress.listen(httpServer, 3000, () =>
//   console.log("Server is listening on port 3000..."),
// );
