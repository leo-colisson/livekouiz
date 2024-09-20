import strawberry
# Run with:
# nix-shell -p "(python3.withPackages (ps: with ps; [ strawberry-graphql typer ] ++ strawberry-graphql.optional-dependencies.debug-server))"
# Test with:
# http://0.0.0.0:8000/graphql
# or 
# curl -X POST -d '{"query": "query MyQuery { user { age name }}"}' -H 'Content-Type: application/json' "http://0.0.0.0:8000/graphql"

@strawberry.type
class User:
    name: str
    age: int


@strawberry.type
class Query:
    @strawberry.field
    def user(self) -> User:
        return User(name="Patrick", age=100)


schema = strawberry.Schema(query=Query)
