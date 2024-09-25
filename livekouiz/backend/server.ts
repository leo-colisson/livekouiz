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
const redisKeyLastQuestionId = (roomName) => `room-last-question-id:${roomName}`;
const redisKeyQuestion = (roomName) => `room-question:${roomName}`;
const redisKeyQuestionSubscribe = (roomName) => `room-question-subscribe:${roomName}`;
const redisKeySolution = (roomName) => `room-solution:${roomName}`;
const redisKeySolutionSubscribe = (roomName) => `room-solution-subscribe:${roomName}`;
const redisKeyScoreSubscribe = (roomName) => `room-score-subscribe:${roomName}`;
const redisKeyRoomAcceptingAnswers = (roomName) => `room-accepting-answrs:${roomName}`;
// This is a hset, with the key being the name of the user, and the key its answer
const redisKeyListUserAnswers = (roomName) => `room-list-user-answers:${roomName}`
// Outputs just {newAnswer: true}, then we re-fetch the whole list of answers manually
const redisKeyNewAnswerSubscribe = (roomName) => `room-new-answer:${roomName}`
// Send a message there when a new person connects or disconnect
const redisKeyNewConnectionSubscribe = (roomName) => `room-new-connection:${roomName}`
// Stores the number of connected users for each graphql client. We can't just use NUMSUB on a channel
// because a single backend server may use a single subscription to the redis server even if many clients are listenning to it.
// Instead, each server will have their own variable (key in hash table), maintaining themself the number of connections they had.
// We need a separate key per server to avoid issues if a server dies. We use HEXPIRE to remove keys after some time (like 1mn),
// and each server regurarly calls HEXPIRE to notify they are still alive.
const redisKeyHashTableNbConnectedCliends = (roomName) => `room-nb-connected-client-per-server:${roomName}`
// Stores the scores in a hash table room-scores:roomName question > {userName: score}
const redisKeyScores = (roomName) => `room-scores:${roomName}`


const serverUuid = uuidv4();
console.log("Server uuid: " + serverUuid)

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
      subscribe: async function* (_, args) {
        const { roomName } = args;
        // Tell others that a new user connected the room
        pubsub.publish(redisKeyNewConnectionSubscribe(roomName), {newConnection: true});
        // Fetch the initial question from Redis
        const question = await redis_get_obj_or_null(redisKeyQuestion(roomName));
        yield {questions: question};
        const iterMessages = pubsub.asyncIterator(redisKeyQuestionSubscribe(roomName));
        while (true) {
          const message = await iterMessages.next();
          yield {questions: message.value}
          //yield message.value
        }
        // for await (const message of iterMessages()) {
        //   yield message;
        // }
      }
    },
    answers: {
      subscribe: async function* (_, args) {
        const {roomName, token} = args;
        const room = await redis_get_obj_or_null(redisKeyRoom(roomName));
        if (room && room.token === token) {
          const allAnswers = await redis.hgetall(redisKeyListUserAnswers(roomName));
          yield {answers: {__typename: "QuestionAnswerList",
                           answers: Object.values(allAnswers).map(x => JSON.parse(x))}}
          const iterMessages = pubsub.asyncIterator(redisKeyNewAnswerSubscribe(args.roomName));
          while (true) {
            const message = await iterMessages.next();
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
    solution: {
      subscribe: async function* (_, args) {
        const { roomName } = args;
        // Fetch the initial question from Redis
        const solution = await redis_get_obj_or_null(redisKeySolution(roomName));
        yield {solution: solution};
        const iterMessages = pubsub.asyncIterator(redisKeySolutionSubscribe(roomName));
        while (true) {
          const message = await iterMessages.next();
          yield {solution: message.value}
        }
      }
    },
    scores: {
      subscribe: async function* (_, args) {
        const { roomName } = args;
        // Fetch the initial question from Redis
        const scores_dict = await redis.hgetall(redisKeyScores(roomName));
        const scores = Object.keys(scores_dict).map(uuid => {
          const dictUserScore = JSON.parse(scores_dict[uuid]);
          return Object.keys(dictUserScore).map(userName => ({
            questionUuid: uuid,
            userName: userName,
            score: dictUserScore[userName]
          }));
        }).flat();
        yield {scores: scores};
        const iterMessages = pubsub.asyncIterator(redisKeyScoreSubscribe(roomName));
        while (true) {
          const message = await iterMessages.next();
          const scores_dict = await redis.hgetall(redisKeyScores(roomName));
          const scores = Object.keys(scores_dict).map(uuid => {
            const dictUserScore = JSON.parse(scores_dict[uuid]);
            return Object.keys(dictUserScore).map(userName => ({
              questionUuid: uuid,
              userName: userName,
              score: dictUserScore[userName]
            }));
          }).flat();
          yield {scores: scores};
        }
      }
    },
    nbPeopleInRoom: {
      subscribe: async function* (_, args) {
        const { roomName } = args;
        var allServersConnectedClients = await redis.hgetall(redisKeyHashTableNbConnectedCliends(roomName));
        var n = Object.values(allServersConnectedClients).map(x => parseInt(x)).reduce((a, b) => a + b, 0)
        yield {nbPeopleInRoom: n}
        const iterMessages = pubsub.asyncIterator(redisKeyNewConnectionSubscribe(roomName));
        while (true) {
          const message = await iterMessages.next();
        var allServersConnectedClients = await redis.hgetall(redisKeyHashTableNbConnectedCliends(roomName));
          n = Object.values(allServersConnectedClients).map(x => parseInt(x)).reduce((a, b) => a + b, 0)
          yield {nbPeopleInRoom: n}
        }
      },
    },
  },
  Mutation: {
    newRoom: async (_, args) => {
      const {roomName, password} = args;
      const room = await redis_get_obj_or_null(redisKeyRoom(roomName));
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
        const uuid = redis.incr(redisKeyLastQuestionId(roomName));
        const typename = Object.keys(question)[0];
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
              pubsub.publish(redisKeyNewAnswerSubscribe(roomName), {newAnswer: true});
              return ans
            }
          }
        }
      }
    },
    newSolution: async (_, args) => {
      const { roomName, token, questionUuid, solution } = args;
      const room = await redis_get_obj_or_null(redisKeyRoom(roomName));
      if (room && room.token === token) {
        const q = {__typename: "Solution", questionUuid: questionUuid, solution: solution};
        await redis_set_obj(redisKeySolution(roomName), q);
        pubsub.publish(redisKeySolutionSubscribe(roomName), q);
        return q;
      } else {
        return {__typename: "WrongToken"};
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
    setScores: async (_, args) => {
      const { roomName, token, questionUuid, scores } = args;
      const room = await redis_get_obj_or_null(redisKeyRoom(roomName));
      if (room && room.token === token) {
        const oldScores = await redis.hget(redisKeyScores(roomName), questionUuid);
        var oldScoresParsed = {};
        // We replace existing scores with new ones
        if(oldScores) {
          oldScoresParsed = JSON.parse(oldScores)
          // oldScoresParsed = Object.keys(oldScoresParsed0).map(userName => ({
          //   userName: userName,
          //   score: oldScoresParsed0[userName]
          // }));
        }
        const newScoresDict = scores.reduce((h, {userName, score}) => ({...h, [userName]: score}), oldScoresParsed)
        await redis.hset(redisKeyScores(roomName), questionUuid, JSON.stringify(newScoresDict));
        redis.publish(redisKeyScoreSubscribe(roomName), {updatedScores: true})
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
// Count the number of connected clients per room for this server, to know when to start/stop
// This maps roomName to number of users
const connectedUsers = {};

// We notify the server that we are still connected every minute, by renewing the expire time of the corresponding keys
setInterval(function() {
  for (const roomName in connectedUsers) {
    redis.call("HEXPIRE", redisKeyHashTableNbConnectedCliends(roomName), 2*60, "FIELDS", 1, serverUuid);
    pubsub.publish(redisKeyNewConnectionSubscribe(roomName), {inCaseStuffExpired: true});
  }
}, 60 * 1000);

// Save the returned server's info so we can shutdown this server later
const serverCleanup = useServer({
  schema,
  onSubscribe: async (ctx, message) => {
    ctx.livekouizID = uuidv4();
    if (message?.type === "subscribe" && message?.payload?.variables?.roomName && message?.payload?.operationName === "Questions") {
      // A user is connecting! Let's save the name of the room to disconnect it later, and add it to the list of users.
      const roomName = message.payload.variables.roomName;
      const x = connectedUsers?.roomName || 0;
      connectedUsers[roomName] = x + 1;
      await (redis.multi()
                  .hincrby(redisKeyHashTableNbConnectedCliends(roomName), serverUuid, 1)
                  .call("HEXPIRE", redisKeyHashTableNbConnectedCliends(roomName), 2*60, "FIELDS", 1, serverUuid)
                  .exec())
      ;
      ctx.livekouizRoomToDisconnect = roomName;
    }
  },
  onDisconnect: async (ctx) => {
    if (ctx?.livekouizRoomToDisconnect) {
      const roomName = ctx.livekouizRoomToDisconnect;
      pubsub.publish(redisKeyNewConnectionSubscribe(roomName), {newDisconnection: true});
      const x = connectedUsers?.roomName || 0;
      connectedUsers[roomName] = x - 1;
      await (redis.multi()
                  .hincrby(redisKeyHashTableNbConnectedCliends(roomName), serverUuid, -1)
                  .call("HEXPIRE", redisKeyHashTableNbConnectedCliends(roomName), 2*60, "FIELDS", 1, serverUuid)
                  .exec());
      // We clean it to remove empty rooms
      for (const key in connectedUsers) {
        if (connectedUsers[key] <= 0) {
          delete connectedUsers[key];
        }
      }
    }
  }
}, wsServer);

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
