# Clowdr

Clowdr is a virtual conference platform project bootstrapped with [Create React App](https://github.com/facebook/create-react-app) and Node.js.

If you want to run it, and help develop, we highly recommend you do it from a Linux environment. The instructions below assume so. If you are on Windows, install [WSL](https://docs.microsoft.com/en-us/windows/wsl/install-win10), and run everything from there.

## Installation

### Install all dependencies

Use npm to install (or upgrade) all dependencies after cloning.

```bash
$ npm install
```

### Set Up a Backend

Clowdr uses the [Parse Platform](https://docs.parseplatform.org/js/guide/)
as the backend. The fastest way of getting this set up is to sign up for
free app hosting in [Back4App](https://www.back4app.com/) and
create an app space for Clowdr with any name you like. The instructions
here assume you have done so.

Although you do not have to run MongoDB when using Back4App, you will need to install mongodb in your local computer in order to initialize Clowdr. Installing MongoDB locally is used only for calling the `mongodbrestore` command that sets up the database schema with the right permissions. Install [MongoDB](https://docs.mongodb.com/manual/administration/install-community/).

### Environment variables

Next, set up your own configuration in ./.env according to ./.env-example.
The configuration parameters can be found from your created app in Back4App
(in Server Settings -> Core Settings). When you come to the mongodb
configuration variables, `MONGODB_PASSWORD` and `MONGODB_DB`, find the
"MongoDB Database URI" in Back4App core server settings, which looks like
this:

`mongodb://admin:XXX@mongodb.back4app.com:27017/YYY?ssl=true`

Use XXX as the MONGODB_PASSWORD, YYY as MONGODB_DB.

BCP: Some Instructions about the MONGODB_HOST var would be useful

### Populate the Database

Run the following script to add and initialize a minimal database:

```bash
$ npm run init-app
```

After this command runs, you should be able to see all tables with some essential data stored in the database in Back4App.

#### Set Up Hosting and Live Query

From the app created in back4app, turn on live queries for the following tables by going to Server Settings -> Web Hosting and Live Query:

![Live Query tables](art/LiveQuery.png?raw=true "Live Query Tables")

#### Cloud Functions

Go to Cloud Functions in your Back4App workspace, upload all js code under backend/cloud, and click "deploy".

## Usage and Further Configuration

After the installation, start the application by executing

```bash
$ npm start
```

This will pop up a tab in your default browser and from there you can log into the website using the login credentials:

`clowdr@localhost / admin`

### Set up Twilio for your test conference

Once you login with the admin account, go to Administration->Conference Configuration to enter the Twilio credentials for chat. You must enter, at least the following configuration variables:

| Config Value | Description |
| ------------ | ----------- |
| `TWILIO_ACCOUNT_SID` | [Your primary Twilio account identifier](https://www.twilio.com/console).|
|`TWILIO_API_KEY` | [Used to authenticate](https://www.twilio.com/console/dev-tools/api-keys).|
|`TWILIO_API_SECRET` | [Used to authenticate](https://www.twilio.com/console/dev-tools/api-keys).|
|`TWILIO_CHAT_SERVICE_SID` | [Chat](https://www.twilio.com/console/chat/services)|
|`FRONTEND_URL` | http://localhost:3000, for development|

After entering these variables, press the big red button for initializing the conference, and logout.

### Backend Setup

From here on, you must also run the [backend](https://github.com/clowdr-app/clowdr-backend) server. Follow the instructions there.

After running the token server, login to your Clowdr app again. This time, you should see two additional panels, one on the left side and one on the right side, both related to text and video chat.

## Contributing
Pull requests are welcome. For major changes, please open an issue first to discuss what you would like to change.

Join us on the Slack [CLOWDR](clowdr.slack.com) workspace!
