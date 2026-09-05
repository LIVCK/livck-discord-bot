import { Sequelize } from 'sequelize';
import dotenv from "dotenv";

dotenv.config();

const connection = new Sequelize(process.env.DB_DATABASE, process.env.DB_USERNAME, process.env.DB_PASSWORD, {
    host: process.env.DB_HOST,
    dialect: 'mariadb',
    logging: false,
});
connection.authenticate()
    .then(() => console.log('Connection has been established successfully.'))
    .catch((error) => {
        // Fatal, like a failed Discord login. Logging and carrying on left the bot in its
        // worst possible state: the update loop catches and reschedules unconditionally, so
        // the process spun for ever, emitting one "[UpdateLoop] Critical error" every 15
        // seconds and delivering nothing — while never exiting, so supervisord's
        // `autorestart` never fired and nothing ever noticed. Tests import this module
        // routinely with no database, so only a real run exits.
        console.error('Unable to connect to the database:', error);

        if (process.env.NODE_ENV !== 'test') {
            process.exit(1);
        }
    });

export default connection;
