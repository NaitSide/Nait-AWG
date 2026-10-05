'use strict';

const express = require('express');
const {
  getAwgStatus,
  getAwgProfile,
  getAwgPeers
} = require('../services/awgService');
const {
  createAwgPeerSkeleton,
  dryRunCreateAwgPeer,
  deleteAwgPeerSkeleton,
  dryRunDeleteAwgPeer
} = require('../services/awgPeerService');
const {
  clearAwgGate,
  fenceAwgGate,
  getAwgGateOperation,
  readAwgGate,
  setAwgGate
} = require('../services/awgGateService');
const { restoreAwgConfig } = require('../services/awgRestoreService');
const { createObfuscationService } = require('../services/awgObfuscationService');
const obfuscation = createObfuscationService();

const router = express.Router();
// Recover a crashed obfuscation write before allowing any other AWG mutation.
router.use(async(_req,res,next)=>{
  try{if(obfuscation.hasPending())await obfuscation.recover();next();}
  catch(error){res.status(error.statusCode||503).json({code:error.code||'obfuscation_recovery_failed',message:'Прерванное изменение обфускации требует проверки. Изменения AWG приостановлены.'});}
});
router.get('/obfuscation', async (_req,res,next)=>{
  try {res.json(await obfuscation.get());} catch(error){res.status(error.statusCode||500).json({code:error.code||'obfuscation_failed',message:error.statusCode?error.message:'Не удалось проверить обфускацию.'});}
});
router.post('/obfuscation', async (req,res,next)=>{
  try {res.json(await obfuscation.set(req.body));} catch(error){res.status(error.statusCode||500).json({code:error.code||'obfuscation_failed',message:error.statusCode?error.message:'Не удалось изменить обфускацию.'});}
});

router.get('/status', async (req, res, next) => {
  try {
    res.json(await getAwgStatus());
  } catch (error) {
    next(error);
  }
});

router.get('/profile', async (req, res, next) => {
  try {
    res.json(await getAwgProfile());
  } catch (error) {
    next(error);
  }
});

router.get('/peers', async (req, res, next) => {
  try {
    res.json(await getAwgPeers());
  } catch (error) {
    next(error);
  }
});

router.post('/restore', async (req, res, next) => {
  try {
    const result = await restoreAwgConfig(req);
    res.status(result.statusCode).json(result.body);
  } catch (error) {
    next(error);
  }
});

for (const [path, handler] of [
  ['/gates/read', readAwgGate],
  ['/gates/fence', fenceAwgGate],
  ['/gates/operations/get', getAwgGateOperation],
  ['/gates/clear', clearAwgGate],
  ['/gates/set', setAwgGate]
]) {
  router.post(path, async (req, res, next) => {
    try {
      const result = await handler(req);
      res.status(result.statusCode).json(result.body);
    } catch (error) {
      next(error);
    }
  });
}

router.post('/peers', async (req, res, next) => {
  try {
    const result = await createAwgPeerSkeleton(req);
    res.status(result.statusCode).json(result.body);
  } catch (error) {
    next(error);
  }
});

router.post('/peers/dry-run', async (req, res, next) => {
  try {
    const result = await dryRunCreateAwgPeer(req);
    res.status(result.statusCode).json(result.body);
  } catch (error) {
    next(error);
  }
});

router.post('/peers/delete/dry-run', async (req, res, next) => {
  try {
    const result = await dryRunDeleteAwgPeer(req);
    res.status(result.statusCode).json(result.body);
  } catch (error) {
    next(error);
  }
});

router.delete('/peers/:publicKeyFingerprint', async (req, res, next) => {
  try {
    const result = await deleteAwgPeerSkeleton(req);
    res.status(result.statusCode).json(result.body);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
