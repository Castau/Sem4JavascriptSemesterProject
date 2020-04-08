const path = require('path')
require('dotenv').config({ path: path.join(process.cwd(), '.env') })
import IPoint from '../interfaces/Point';
import * as mongo from "mongodb"
import { ApiError } from "../errors/apiError"
import UserFacade from "./userFacadeWithDB"
import IPosition from '../interfaces/Position';
import IPost from '../interfaces/Post';
import { positionCreator } from "../utils/geoUtils"
import { POSITION_COLLECTION_NAME, POST_COLLECTION_NAME } from "../config/collectionNames"
import IGameUser from '../interfaces/GameUser';

let positionCollection: mongo.Collection;
let postCollection: mongo.Collection;
const EXPIRES_AFTER = 30;

export default class GameFacade {

    static readonly DIST_TO_CENTER = 15
    static readonly POST_DISTANCE = 10

    static async setDatabase(client: mongo.MongoClient) {
        const dbName = process.env.DB_NAME;
        if (!dbName) {
            throw new Error("Database name not provided")
        }
        await UserFacade.setDatabase(client);

        try {
            if (!client.isConnected()) {
                await client.connect();
            }
            positionCollection = client.db(dbName).collection(POSITION_COLLECTION_NAME);
            await positionCollection.createIndex({ "lastUpdated": 1 }, { expireAfterSeconds: EXPIRES_AFTER })
            await positionCollection.createIndex({ location: '2dsphere' })
            postCollection = client.db(dbName).collection(POST_COLLECTION_NAME);
            await postCollection.createIndex({ location: "2dsphere" })
            return client.db(dbName);

        } catch (err) {
            console.error("Could not connect", err)
        }
    }

    static async nearbyPlayers(userName: string, password: string, longitude: number, latitude: number, distance: number) {
        let user: IGameUser;
        try {
            user = await UserFacade.getUser(userName)
            await UserFacade.checkUser(userName, password)
        } catch (err) {
            throw new ApiError("wrong username or password", 403)
        }

        try {
            const point = { type: "Point", coordinates: [longitude, latitude] }
            const date = new Date();
            const found = await positionCollection.findOneAndUpdate(
                { userName },
                {
                    $set: {
                        userName,
                        name: user.name,
                        lastUpdated: date,
                        location: point
                    }
                },
                { upsert: true, returnOriginal: false }
                //{ upsert: true/*, returnOriginal: true*/ }  //Figure out why you probably need to set both of these
            )

            const nearbyPlayers = await GameFacade.findNearbyPlayers(userName, point, distance);
            const formatted = nearbyPlayers.map((player) => {
                return {
                    userName: player.userName,
                    lat: player.location.coordinates[0],
                    lon: player.location.coordinates[1],
                    lastUpdated: player.lastUpdated
                }
            })
            return formatted
        } catch (err) {
            throw err;
        }
    }
    private static async findNearbyPlayers(clientUserName: string, point: IPoint, distance: number): Promise<Array<IPosition>> {
        try {
            const found = await positionCollection.find(
                {
                    userName: { $ne: clientUserName },
                    location:
                    {
                        $near:
                        {
                            $geometry: point,
                            $maxDistance: distance
                        }
                    }
                }
            )
            return found.toArray();
        } catch (err) {
            throw err;
        }
    }

    static async getPostIfReached(postId: string, lat: number, lon: number): Promise<any> {
        try {
            const post: IPost | null = await postCollection.findOne(
                {
                    _id: postId,
                    location:
                    {
                        $near: {
                            $geometry: { type: 'Point', coordinates: [lat, lon] },
                            $maxDistance: this.POST_DISTANCE
                        }
                    }
                }
            )
            if (post === null) {
                throw new ApiError("Post not reached", 400);
            }
            return { postId: post._id, task: post.task.text, isUrl: post.task.isUrl };
        } catch (err) {
            throw err;
        }
    }

    //You can use this if you like, to add new post's via the facade
    static async addPost(
        name: string,
        taskTxt: string,
        isUrl: boolean,
        taskSolution: string,
        lon: number,
        lat: number
    ): Promise<IPost> {
        const position = { type: "Point", coordinates: [lon, lat] };
        const status = await postCollection.insertOne({
            _id: name,
            task: { text: taskTxt, isUrl },
            taskSolution,
            location: {
                type: "Point",
                coordinates: [lon, lat]
            }
        });
        const newPost: any = status.ops;
        return newPost as IPost
    }
}

