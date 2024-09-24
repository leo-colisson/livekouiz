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
        #pkgs.redis
        # To get HEXPIRE we need redis 7.4.0. They also changed the license to non-free, so I plan to move to
        # valkey once they implement it:
        # https://github.com/valkey-io/valkey/issues/1070
        (pkgs.callPackage ./redis-7.4.0.nix {})
        pkgs.nodejs_latest
      ];
    };

  };
}
