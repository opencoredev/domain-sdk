import { register } from "node:module";

register("./no-builtins-loader.mjs", import.meta.url);
