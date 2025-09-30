import database from '../database/index.js'
import Subscription from "./Subscription.js";
import Statuspage from "./Statuspage.js";
import Message from "./Message.js";
import CustomLink from "./CustomLink.js";

const models = {
    Subscription: Subscription(database),
    Statuspage: Statuspage(database),
    Message: Message(database),
    CustomLink: CustomLink(database),
};

Object.keys(models).forEach((modelName) => {
    if (models[modelName].associate) {
        models[modelName].associate(models);
    }
});

export default {
    database,
    ...models,
};
