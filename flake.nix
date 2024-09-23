{
  description = "A very basic flake";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs?ref=nixos-unstable";
  };

  outputs = { self, nixpkgs }: {

    # nix develop
    devShells.x86_64-linux.default = let pkgs = nixpkgs.legacyPackages.x86_64-linux; in pkgs.mkShell {
      packages = [
        (pkgs.python3.withPackages (ps: with ps; [
          ipython
          strawberry-graphql
          typer
          redis
          bcrypt
          pydantic
        ]
        ++ strawberry-graphql.optional-dependencies.debug-server
        ++ uvicorn.optional-dependencies.standard))
        pkgs.redis
        pkgs.nodejs_latest
      ];
    };

  };
}
