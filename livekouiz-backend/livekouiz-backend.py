import asyncio
import typing
from typing import Literal, Union
import strawberry
from strawberry.asgi import GraphQL
import redis.asyncio as redis
import json
from uuid import uuid4
from dataclasses import asdict, field
import os
import bcrypt
from pydantic import BaseModel

# Run with:
# nix-shell -p "(python3.withPackages (ps: with ps; [ strawberry-graphql typer redis uuid bcrypt ] ++ strawberry-graphql.optional-dependencies.debug-server ++ uvicorn.optional-dependencies.standard ))"
# Test with:
# http://0.0.0.0:8000/graphql
# or 
# curl -X POST -d '{"query": "query MyQuery { user { age name }}"}' -H 'Content-Type: application/json' "http://0.0.0.0:8000/graphql"

# We cannot just use a python object as a database since we have multiple threads. Channels seems to be
# actually more complicated to use than redis (and it adds a dependency on django, is specific to asgi...)
redis_url = os.getenv('REDIS_URL', 'redis://localhost:6379')
redis_conn = redis.from_url(redis_url, decode_responses=True)

### Redis keys
def redis_key_room(roomName):
    # It is important to end with :info or alike, to avoid attacks like
    # https://stackoverflow.com/a/26528595/4987648
    return f"room:{roomName}:info"

def redis_key_question(roomName):
    return f"room:{roomName}:question"

def redis_ch_question(roomName):
    return f"room:{roomName}:question-channel"

### Pydantic types (used to validate inputs and serialize/deserialize to the database)

class Room(BaseModel):
    name: str
    adminHashedPassword: str
    token: str # This token is given to the owner of the room to allow further changes, this way we don't need to re-compute the password hash on any new query (might be costly). I could use headers to transport it, but it is a bit simpler this way

class QuestionMultipleChoice(BaseModel):
    kind: Literal['QuestionMultipleChoice'] = "QuestionMultipleChoice"
    nbChoices: int

class QuestionText(BaseModel):
    kind: Literal['QuestionText'] = "QuestionText"
    
class QuestionNumber(BaseModel):
    kind: Literal['QuestionNumber'] = "QuestionNumber"

Question = Union[
    QuestionMultipleChoice,
    QuestionText,
    QuestionNumber
]
    
### QraphQL types: this will represent the type of the GraphQL queries

@strawberry.experimental.pydantic.type(model=Room, all_fields=True)
class RoomType:
    pass

QuestionType = typing.Annotated[Question, strawberry.union("Question")]

@strawberry.experimental.pydantic.input(model=QuestionMultipleChoice, all_fields=True)
class QuestionMultipleChoiceInputType:
    pass

@strawberry.experimental.pydantic.input(model=QuestionText, all_fields=True)
class QuestionTextInputType:
    pass

@strawberry.experimental.pydantic.input(model=QuestionNumber, all_fields=True)
class QuestionNumberInputType:
    pass

@strawberry.input(one_of=True)
class QuestionInputType:
    QuestionMultipleChoice: QuestionMultipleChoiceInputType | None = strawberry.UNSET
    QuestionText: QuestionTextInputType | None = strawberry.UNSET
    QuestionNumber: QuestionNumberInputType | None = strawberry.UNSET

### GraphQL Errors
@strawberry.type
class WrongPassword:
    error: str = field(default_factory= lambda: "wrong-password")

@strawberry.type
class WrongToken:
    error: str = field(default_factory= lambda: "wrong-token")

@strawberry.type
class Success:
    success: str = field(default_factory= lambda: True)



# Wait for a pydantic input
async def redis_set_obj(key, obj):
    print(f"We will add {obj} to {key}")
    return await redis_conn.set(key, obj.model_dump_json())

# Returns a pydantic output
async def redis_get_obj(key, cls):
    txt = await redis_conn.get(key)
    print(txt, key)
    return cls.model_validate_json(txt)

async def redis_get_obj_or_None(key, cls):
    txt = await redis_conn.get(key)
    if txt:
        return cls.model_validate_json(txt)
    else:
        return None


### Query/subscription/mutation entrypoints

@strawberry.type
class Query:
    @strawberry.field
    def hello(self) -> str:
        return "world"

@strawberry.type
class Subscription:
    @strawberry.subscription
    async def count(self, target: int = 100) -> typing.AsyncGenerator[int, None]:
        for i in range(target):
            yield i*2
            await asyncio.sleep(0.5)

    @strawberry.subscription
    async def questions(self, roomName: str) -> typing.AsyncGenerator[QuestionType | None, None]:
        # For the very first message, we read the database
        try:
            question = redis_get_obj(redis_key_question(roomName), Question)
            yield QuestionType.from_pydantic(question)
        except:
            yield None
        async with redis_conn.pubsub() as pubsub:
            await pubsub.subscribe(redis_ch_question(roomName))
            while True:
                message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=None)
                if message is not None:
                    print(f"I received {message}")
                    question = Question.model_validate_json(message["data"])
                    yield QuestionType.from_pydantic(question)

@strawberry.type
class Mutation:
    @strawberry.mutation
    async def new_room(self,
                       roomName: str,
                       password: str) -> typing.Union[RoomType, WrongPassword]:
        room = await redis_get_obj_or_None(redis_key_room(roomName), Room)
        print("room", room)
        if room:
            if not bcrypt.checkpw(password.encode(), room.adminHashedPassword.encode()):
                return WrongPassword()
            return RoomType.from_pydantic(room)
        else:
            hashed = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
            token = str(uuid4())
            room = Room(name=roomName, adminHashedPassword=hashed, token=token)
            await redis_conn.set_obj(redis_key_room(roomName), room)
            return RoomType.from_pydantic(room)
        
    @strawberry.mutation
    async def new_question(
            self,
            roomName: str,
            token: str,
            question: QuestionInputType,
    ) -> typing.Union[WrongToken, Success]:
        room = await redis_get_obj_or_None(redis_key_room(roomName), Room)
        if room and room.token == token:
            name = list(asdict(question).keys())[0]
            q_dict = getattr(question, name)
            print("ssss", q)
            question = Question.model_validate({**q_dict, kind: name})
            await redis_set_obj(redis_key_question(roomName), q)
            await redis_conn.publish(redis_ch_question(roomName), q.model_dump_json())
            return Success()
        else:
            return WrongToken()
                                
schema = strawberry.Schema(query=Query, mutation=Mutation, subscription=Subscription)

# Create ASGI app for Uvicorn
app = GraphQL(schema)
