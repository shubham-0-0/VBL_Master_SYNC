require('dotenv').config();

// Accepts '1'/'true'/'yes' (case-insensitive) as enabled; anything else (including unset) is disabled.
function isFlagEnabled(value) {
  return ['1', 'true', 'yes'].includes(String(value || '').trim().toLowerCase());
}

module.exports = {
  aws: {
    s3: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      region: process.env.AWS_REGION || 'us-east-1',
      bucket: process.env.AWS_BUCKET_NAME
    }
  },
  mysql: {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'integration_db',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  },
  vbl: {
    api: {
      baseUrl: process.env.VBL_API_BASE_URL,
      companyCode: process.env.VBL_COMPANY_CODE,
      division: process.env.VBL_DIVISION,
      distChannel: process.env.VBL_DIST_CHANNEL,
      custGroup: process.env.VBL_CUST_GROUP
    },
    auth: {
      clientId: process.env.VBL_CLIENT_ID,
      clientSecret: process.env.VBL_CLIENT_SECRET
    }
  },
  directories: {
    upload: 'upload',
    distributor: 'upload/distributor',
    route: 'upload/route'
  },
  // Blob-storage mount for archiving synced source files, organized by sync
  // type and date: <basePath>/<folder>/<YYYY-MM-DD>/<fileName>. Each sync's
  // archiving can be toggled independently, and flipping a flag off only
  // stops future archiving - it never touches files already written.
  storage: {
    basePath: process.env.UPLOAD_DIRECTORY_PATH || '/appdir/CampusBlob/client/vegahrzaunl7avbl/vegahr-backend/',
    distributor: {
      enabled: isFlagEnabled(process.env.STORE_DISTRIBUTOR_FILES),
      folder: 'distributor'
    },
    route: {
      enabled: isFlagEnabled(process.env.STORE_ROUTE_FILES),
      folder: 'route'
    },
    visitData: {
      enabled: isFlagEnabled(process.env.STORE_VISIT_DATA_FILES),
      folder: 'visit_data'
    }
  },
  visitData: {
    // Bucket is configured separately; this is the key prefix inside that bucket.
    s3PrefixBase: 'SPEED/VISIT_DATA',
    // Local directory where the raw downloaded CSV is saved.
    rawDir: 'upload/visit_data',
    tempTable: 'integration_visit_data_temp',
    // Order MUST match keysToStore below.
    insertColumns: [
      'DIST_CD', 'SLSMAN_CD', 'VISIT_DT', 'CUST_CD', 'VISIT_ID', 'VISIT_KEY',
      'TIME_IN', 'TIME_OUT', 'TIME_SPENT', 'SLSORD_AMT', 'CSHORD_AMT',
      'VISIT_TYPE', 'VISIT_IND', 'HHT_SUBMIT_DT', 'TIME_OUT_LONG', 'TIME_OUT_LAT',
      'ORDER_NO'
    ],
    // Order MUST match insertColumns above.
    keysToStore: [
      'DIST_CD', 'SLSMAN_CD', 'VISIT_DT', 'CUST_CD', 'VISIT_ID', 'VISIT_KEY',
      'TIME_IN', 'TIME_OUT', 'TIME_SPENT', 'SLSORD_AMT', 'CSHORD_AMT',
      'VISIT_TYPE', 'VISIT_IND', 'HHT_SUBMIT_DT', 'TIME_OUT_LONG', 'TIME_OUT_LAT',
      'ORDER_NO'
    ]
  },
  keysToStore: [
    "Distributor_Code", "DBR_Name", "Customer_Code", "Customer_Name", "Route_Code",
    "Address", "Latitude", "Longitude", "Visit_Frequency",
    "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
    "upload_type", "uploaded_at","status","isHVO","BusinessUnit"
  ],
  weekdayMap: {
    mon: "Monday", monday: "Monday",
    tue: "Tuesday", tuesday: "Tuesday",
    wed: "Wednesday", wednesday: "Wednesday",
    thu: "Thursday", thursday: "Thursday",
    fri: "Friday", friday: "Friday",
    sat: "Saturday", saturday: "Saturday",
    sun: "Sunday", sunday: "Sunday"
  },
  // Default sync date (null means current date)
  syncDate: null
}; 
