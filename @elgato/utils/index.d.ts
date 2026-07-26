declare module '@elgato/utils' {
  export type JsonObject = Record<string, any>;
  export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
}