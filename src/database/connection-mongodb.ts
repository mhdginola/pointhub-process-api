import { ApiError } from "@point-hub/express-error-handler";
import { fileSearch } from "@point-hub/express-utils";
import {
  MongoClient,
  MongoClientOptions,
  FindOptions,
  Collection,
  Db,
  InsertOneOptions,
  BulkWriteOptions,
  UpdateOptions,
  DeleteOptions,
  ClientSession,
  DbOptions,
  CollectionOptions,
  ObjectId,
  AggregateOptions,
  IndexSpecification,
  CreateIndexesOptions,
  CreateCollectionOptions,
  DropCollectionOptions,
  MongoServerError,
} from "mongodb";

import {
  IDatabaseAdapter,
  DocumentInterface,
  QueryInterface,
  DeleteResultInterface,
  UpdateResultInterface,
  ReadManyResultInterface,
  ReadResultInterface,
  CreateResultInterface,
  CreateOptionsInterface,
  ReadOptionsInterface,
  ReadManyOptionsInterface,
  UpdateOptionsInterface,
  DeleteOptionsInterface,
  AggregateOptionsInterface,
  AggregateQueryInterface,
  DeleteManyOptionsInterface,
  DeleteManyResultInterface,
  AggregateResultInterface,
  CreateManyResultInterface,
} from "./connection.js";

import MongoError from "./mongodb-error-handler.js";
import { fields, limit, page, skip, sort } from "./mongodb-querystring.js";
import { IMongoDBConfig } from "@src/config/database.js";

export default class MongoDbConnection implements IDatabaseAdapter {
  public client: MongoClient;
  public config: IMongoDBConfig;
  public _database: Db | undefined;
  public _collection: Collection | undefined;
  public session: ClientSession | undefined;

  constructor(config: IMongoDBConfig) {
    const options: MongoClientOptions = {};

    this.config = config;
    this.client = new MongoClient(this.url(), options);
  }

  public url(): string {
    return this.config.url ?? "";
  }

  /**
   * Open connection to connect the client to the server (optional starting in v4.7)
   * https://www.mongodb.com/docs/drivers/node/current/fundamentals/connection/connect/
   */
  public async open(): Promise<void> {
    await this.client.connect();
  }

  public async close(): Promise<void> {
    await this.client.close();
  }

  public database(name: string, options?: DbOptions): this {
    this._database = this.client.db(name, options);
    return this;
  }

  public async listCollections(): Promise<Array<{ name: string }>> {
    if (!this._database) {
      throw new Error("Database not found");
    }

    return await this._database.listCollections().toArray();
  }

  public collection(name: string, options?: CollectionOptions): this {
    if (!this._database) {
      throw new Error("Database not found");
    }

    this._collection = this._database.collection(name, options);
    return this;
  }

  public async createIndex(name: string, spec: IndexSpecification, options: CreateIndexesOptions): Promise<void> {
    if (!this._database) {
      throw new Error("Database not found");
    }

    await this._database.createIndex(name, spec, options);
  }

  public async updateSchema(name: string, schema: unknown): Promise<void> {
    if (!this._database) {
      throw new Error("Database not found");
    }

    await this._database.command({
      collMod: name,
      validator: {
        $jsonSchema: schema,
      },
    });
  }

  public async createCollection(name: string, options: CreateCollectionOptions): Promise<void> {
    if (!this._database) {
      throw new Error("Database not found");
    }

    await this._database.createCollection(name, options);
  }

  public async dropCollection(name: string, options: DropCollectionOptions): Promise<void> {
    if (!this._database) {
      throw new Error("Database not found");
    }

    await this._database.dropCollection(name, options);
  }

  public async createCollections(): Promise<void> {
    const object = await fileSearch("/*.schema.ts", "./src/modules", { maxDeep: 2, regExp: true });
    for (const property in object) {
      const path = `../modules/${object[property].path.replace("\\", "/").replace(".ts", ".js")}`;
      const { createCollection } = await import(path);
      await createCollection(this);
    }
  }

  public async dropCollections(): Promise<void> {
    const object = await fileSearch("/*.schema.ts", "./src/modules", { maxDeep: 2, regExp: true });
    for (const property in object) {
      const path = `../modules/${object[property].path.replace("\\", "/").replace(".ts", ".js")}`;
      const { dropCollection } = await import(path);
      await dropCollection(this);
    }
  }

  public async create(doc: DocumentInterface, options?: CreateOptionsInterface): Promise<CreateResultInterface> {
    if (!this._collection) {
      throw new Error("Collection not found");
    }

    try {
      const insertOneOptions = options as InsertOneOptions;
      insertOneOptions.writeConcern = {
        w: "majority",
      };

      // inject created date
      doc.createdAt = new Date();

      const response = await this._collection.insertOne(doc, insertOneOptions);

      return {
        acknowledged: response.acknowledged,
        _id: response.insertedId.toString(),
      };
    } catch (error) {
      if (error instanceof MongoServerError) {
        throw new MongoError(error);
      }
      throw error;
    }
  }

  public async createMany(
    docs: DocumentInterface[],
    options?: CreateOptionsInterface
  ): Promise<CreateManyResultInterface> {
    if (!this._collection) {
      throw new Error("Collection not found");
    }

    try {
      const bulkWriteOptions = options as BulkWriteOptions;

      const response = await this._collection.insertMany(docs, bulkWriteOptions);

      const ids: Array<string> = [];

      Object.values(response.insertedIds).forEach((val) => {
        ids.push(val.toString());
      });

      return {
        acknowledged: response.acknowledged,
        insertedCount: response.insertedCount,
        insertedIds: ids,
      };
    } catch (error) {
      if (error instanceof MongoServerError) {
        throw new MongoError(error);
      }
      throw error;
    }
  }

  public async read(id: string, options?: ReadOptionsInterface): Promise<ReadResultInterface> {
    if (!this._collection) {
      throw new Error("Collection not found");
    }

    const readOptions = options as FindOptions;
    const result = await this._collection.findOne(
      {
        _id: new ObjectId(id),
      },
      readOptions
    );

    if (!result) {
      throw new ApiError(404);
    }

    const { _id, ...newResult } = result;

    return {
      _id: _id.toString(),
      ...newResult,
    };
  }

  public async readMany(query: QueryInterface, options?: ReadManyOptionsInterface): Promise<ReadManyResultInterface> {
    if (!this._collection) {
      throw new Error("Collection not found");
    }

    const readOptions = options as FindOptions;
    const cursor = this._collection
      .find(query.filter ?? {}, readOptions)
      .limit(limit(query.pageSize))
      .skip(skip(page(query.page), limit(query.pageSize)));

    if (sort(query.sort)) {
      cursor.sort(sort(query.sort));
    }

    if (fields(query.fields, query.excludeFields)) {
      cursor.project(fields(query.fields, query.excludeFields));
    }

    const result = await cursor.toArray();

    const totalDocument = await this._collection.countDocuments(query.filter ?? {}, readOptions);

    return {
      data: result as Array<unknown> as Array<ReadResultInterface>,
      pagination: {
        page: page(query.page),
        pageCount: Math.ceil(totalDocument / limit(query.pageSize)),
        pageSize: limit(query.pageSize),
        totalDocument,
      },
    };
  }

  public async update(
    id: string,
    document: DocumentInterface,
    options?: UpdateOptionsInterface
  ): Promise<UpdateResultInterface> {
    if (!this._collection) {
      throw new Error("Collection not found");
    }

    const updateOptions = options as UpdateOptions;

    // inject date of updated
    document.updatedAt = new Date();

    try {
      const result = await this._collection.updateOne({ _id: new ObjectId(id) }, { $set: document }, updateOptions);

      return {
        acknowledged: result.acknowledged,
        modifiedCount: result.modifiedCount,
        upsertedId: result.upsertedId.toString(),
        upsertedCount: result.upsertedCount,
        matchedCount: result.matchedCount,
      };
    } catch (error) {
      if (error instanceof MongoServerError) {
        throw new MongoError(error);
      }
      throw error;
    }
  }

  public async updateMany(
    documents: Array<DocumentInterface>,
    options?: UpdateOptionsInterface
  ): Promise<UpdateResultInterface> {
    if (!this._collection) {
      throw new Error("Collection not found");
    }

    const updateOptions = options as UpdateOptions;

    try {
      const result = await this._collection.updateMany(
        { _id: new ObjectId("asd") },
        { $set: documents },
        updateOptions
      );

      return {
        acknowledged: result.acknowledged,
        modifiedCount: result.modifiedCount,
        upsertedId: result.upsertedId.toString(),
        upsertedCount: result.upsertedCount,
        matchedCount: result.matchedCount,
      };
    } catch (error) {
      if (error instanceof MongoServerError) {
        throw new MongoError(error);
      }
      throw error;
    }
  }

  public async delete(id: string, options?: DeleteOptionsInterface): Promise<DeleteResultInterface> {
    if (!this._collection) {
      throw new Error("Collection not found");
    }

    const deleteOptions = options as DeleteOptions;

    const result = await this._collection.deleteOne(
      {
        _id: new ObjectId(id),
      },
      deleteOptions
    );

    return {
      acknowledged: result.acknowledged,
      deletedCount: result.deletedCount,
    };
  }

  public async deleteMany(
    listId: Array<string>,
    options?: DeleteManyOptionsInterface
  ): Promise<DeleteManyResultInterface> {
    if (!this._collection) {
      throw new Error("Collection not found");
    }

    const deleteOptions = options as DeleteOptions;

    const result = await this._collection.deleteMany(
      {
        _id: new ObjectId("asd"),
      },
      deleteOptions
    );

    return {
      acknowledged: result.acknowledged,
      deletedCount: result.deletedCount,
    };
  }

  public async deleteAll(options?: DeleteManyOptionsInterface): Promise<DeleteManyResultInterface> {
    if (!this._collection) {
      throw new Error("Collection not found");
    }

    const deleteOptions = options as DeleteOptions;

    const result = await this._collection.deleteMany({}, deleteOptions);

    return {
      acknowledged: result.acknowledged,
      deletedCount: result.deletedCount,
    };
  }

  public async aggregate(
    pipeline: Array<never>,
    query: AggregateQueryInterface,
    options?: AggregateOptionsInterface
  ): Promise<AggregateResultInterface> {
    if (!this._collection) {
      throw new Error("Collection not found");
    }

    const aggregateOptions = options as AggregateOptions;

    const cursor = this._collection.aggregate(
      [...pipeline, { $skip: (query.page - 1) * query.pageSize }, { $limit: query.pageSize }],
      aggregateOptions
    );

    const result = await cursor.toArray();

    const cursorPagination = this._collection.aggregate([...pipeline, { $count: "totalDocument" }], aggregateOptions);
    const resultPagination = await cursorPagination.toArray();

    const totalDocument = resultPagination.length ? resultPagination[0].totalDocument : 0;
    return {
      data: result as Array<ReadResultInterface>,
      pagination: {
        page: page(query.page),
        pageCount: Math.ceil(totalDocument / limit(query.pageSize)),
        pageSize: limit(query.pageSize),
        totalDocument,
      },
    };
  }

  public startSession() {
    this.session = this.client.startSession();
    return this.session;
  }

  public async endSession(): Promise<this> {
    await this.session?.endSession();
    return this;
  }

  public startTransaction() {
    this.session?.startTransaction();
    return this;
  }

  public async commitTransaction() {
    await this.session?.commitTransaction();
    return this;
  }

  public async abortTransaction() {
    await this.session?.abortTransaction();
    return this;
  }
}
