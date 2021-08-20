const util = require("util");

const { Storage } = require('@google-cloud/storage');
const Busboy = require('busboy');

const storage = new Storage();
const bucket = storage.bucket('testing_app_files');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function useMiddleware(middleware, handler) {
  return async (req, res, next) => {
    try {
      await middleware(req, res, async (err) => {
        if (err) next(err);
        try {
          await handler(req, res, next);
        } catch (error) {
          next(error);
        } 
      })
    } catch (error) {
      next(error);
    }
  }
}

const getAll = async (req, res) => {
  res.status(200).send(
    (await bucket.getFiles())[0].map(file => ({name: file.metadata.name, url: file.metadata.selfLink}))
  );
};

const processFiles = (req, res, next) => {
  const busboy = new Busboy({ headers: req.headers });

  // This object will accumulate all the fields, keyed by their name
  if(!req.body) req.body = {};

  // This object will accumulate all the uploaded files, keyed by their fieldname.
  req.files = {};

  // This code will process each non-file field in the form.
  busboy.on('field', (fieldname, val) => {
    console.log("Processing field:", fieldname);
    req.body[fieldname] = val;
  });

  // This code will process each file uploaded.
  busboy.on('file', (fieldname, file, filename) => {
    console.log("Processing file:", filename);
    const buffers = [];
    file.on('data', (buffer) => {
      buffers.push(buffer);
    })
    file.on('end', () => {
      req.files[fieldname] = {
        name: filename,
        buffer: Buffer.concat(buffers)
      };
    })
  });

  // Triggered once all uploaded files are processed by Busboy.
  // We still need to wait for the disk writes (saves) to complete.
  busboy.on('finish', async () => {
    console.log("Files processed: ", Object.keys(req.files).length);
    next();
  });

  busboy.end(req.rawBody);
}

const getOne = (req, res, next) => { res.redirect(`https://storage.googleapis.com/${bucket.name}/${req.query.name}`) };

const uploadFile = async (req, res, next) => {
  if (req.method !== 'POST') {
    throw new HttpError(405, 'expected method to be "POST"');
  }

  const file = req.files?.['file'];
  if (!file) {
    throw new HttpError(400, "File expected");
  }
  console.log("File received:", file);
  
  // Create a new blob in the bucket and upload the file data.
  const blob = bucket.file(file.name);

  const blobStream = blob.createWriteStream({
    resumable: false,
  });
  blobStream.on("error", (err) => {
    throw new HttpError(500, err.message);
  });

  blobStream.on("finish", async (data) => {
    // Create URL for direct file access via HTTP.
    const publicUrl = util.format(
      `https://storage.googleapis.com/${bucket.name}/${blob.name}`
    );

    try {
      // Make the file public
      await bucket.file(file.name).makePublic();
    } catch {
      return res.status(500).send({
        message:
          `Upload completed: ${file.name}, but public access is denied!`,
        url: publicUrl,
      });
    }

    res.status(200).send({
      message: "Upload completed: " + file.name,
      url: publicUrl,
    });
  });

  if (file.buffer) {
    console.log("Started file upload");
    blobStream.end(file.buffer);
    return;
  }
  throw new HttpError(500, 'Error processing file');
};


const router = {
  "get-all": getAll,
  "upload": useMiddleware(processFiles, uploadFile),
  "get": getOne,
}

exports.index = (req, res) => {
  const handler = router[req.path.slice(1)];
  if (!handler) {
    return res.status(404).send('Not found');
  }

  try {
    handler(req, res, (error) => {
      if (error)
        return res.status(error.status || 500).send('error:' + error.message);
    });
  } catch (error) {
    return res.status(error.status || 500).send('error:' + error.message);
  }
}