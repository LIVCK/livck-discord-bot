import database from '../database/index.js'
import Subscription from "./Subscription.js";
import Statuspage from "./Statuspage.js";
import Message from "./Message.js";
import CustomLink from "./CustomLink.js";
import RoleMention from "./RoleMention.js";

const models = {
    Subscription: Subscription(database),
    Statuspage: Statuspage(database),
    Message: Message(database),
    CustomLink: CustomLink(database),
    RoleMention: RoleMention(database),
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
